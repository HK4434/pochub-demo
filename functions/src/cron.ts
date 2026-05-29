/**
 * PoCHub Functions - Scheduled Cron Jobs
 * v4.78 - Phase 2.8
 *
 * Cloud Scheduler ile tetiklenen idempotent cron'lar.
 *
 * Exports:
 *  - dailyMaintenanceCron   (her gün 03:00 UTC = TR 06:00)
 *  - hourlyBillingCheckCron (her saat)
 *  - weeklyDigestCron       (Pazartesi 09:00 UTC = TR 12:00)
 *
 * NOT: Tüm cron'lar IDEMPOTENT. Yanlışlıkla 2 kez çalışsa veri bozulmaz.
 * Bunun için her gün için tek bir "cron_run/{date}-{type}" kaydı tutulur,
 * varsa skip edilir.
 */

import * as admin from "firebase-admin";
import {onSchedule} from "firebase-functions/v2/scheduler";

// ─────────────────────────────────────────────────────────────────────
// IDEMPOTENCY HELPER
// ─────────────────────────────────────────────────────────────────────

/**
 * Cron'un bu çağrı için zaten çalışmış olup olmadığını kontrol et.
 * Çalışmışsa skip, çalışmamışsa "running" işaretle.
 *
 * @returns true → devam et, false → skip (zaten çalıştı)
 */
async function claimCronRun(cronType: string, dateKey: string): Promise<boolean> {
  const db = admin.firestore();
  const runRef = db.collection("cron_runs").doc(`${dateKey}-${cronType}`);
  const runSnap = await runRef.get();

  if (runSnap.exists) {
    const data = runSnap.data();
    if (data?.status === "completed") {
      console.log(`[cron] ${cronType} for ${dateKey} already completed at ${data.completedAt?.toDate()?.toISOString()}, skipping.`);
      return false;
    }
    // status === 'running' veya 'failed' → tekrar dene (failed retry, running 5dk+ ise crash kabul et)
    const startedAt = data?.startedAt?.toMillis() || 0;
    if (data?.status === "running" && Date.now() - startedAt < 5 * 60 * 1000) {
      console.log(`[cron] ${cronType} for ${dateKey} still running (${Date.now() - startedAt}ms), skipping.`);
      return false;
    }
  }

  await runRef.set({
    cronType,
    dateKey,
    status: "running",
    startedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});

  return true;
}

async function markCronComplete(cronType: string, dateKey: string, stats: any): Promise<void> {
  const db = admin.firestore();
  await db.collection("cron_runs").doc(`${dateKey}-${cronType}`).update({
    status: "completed",
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
    stats: stats,
  });
}

async function markCronFailed(cronType: string, dateKey: string, error: string): Promise<void> {
  const db = admin.firestore();
  await db.collection("cron_runs").doc(`${dateKey}-${cronType}`).set({
    cronType,
    dateKey,
    status: "failed",
    failedAt: admin.firestore.FieldValue.serverTimestamp(),
    error: error.slice(0, 1000),
  }, {merge: true});
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// ═════════════════════════════════════════════════════════════════════
// dailyMaintenanceCron — her gün 03:00 UTC
// ═════════════════════════════════════════════════════════════════════
//
// İşler:
// 1. Süresi dolan vendor_subscriptions → status: expired
// 2. Grace period biten → askıya al (isSuspendedDueToBilling=true)
// 3. Günlük featured rotation oluştur (pochub_daily_featured/{YYYY-MM-DD})
// 4. Trial süresi dolan vendor'lar → downgrade + bildirim
// 5. AutoRenew olan paketler → renewal notification (gerçek charge v4.79+ olur)
//
export const dailyMaintenanceCron = onSchedule(
  {
    schedule: "0 3 * * *", // her gün 03:00 UTC
    timeZone: "UTC",
    region: "europe-west1",
    memory: "512MiB",
    timeoutSeconds: 540,
  },
  async (event) => {
    const today = formatDate(new Date());
    const cronType = "daily_maintenance";

    if (!(await claimCronRun(cronType, today))) {
      return;
    }

    const db = admin.firestore();
    const stats = {
      expired: 0,
      suspended: 0,
      trialEnded: 0,
      featuredCreated: 0,
      autoRenewCandidates: 0,
      errors: [] as string[],
    };

    try {
      const now = admin.firestore.Timestamp.now();
      const nowMs = now.toMillis();

      // ─── 1. Süresi dolan vendor_subscriptions ───
      console.log("[dailyCron] Step 1: expired subscriptions");
      const expiredSnap = await db.collection("vendor_subscriptions")
        .where("status", "in", ["active", "grace_period"])
        .where("endDate", "<", now)
        .limit(500)
        .get();

      const batch = db.batch();
      let batchCount = 0;
      const batches: admin.firestore.WriteBatch[] = [batch];

      for (const sub of expiredSnap.docs) {
        const subData = sub.data();
        const gracePeriodEnd = subData.endDate.toMillis() + 7 * 86400 * 1000; // 7 gün grace

        if (nowMs > gracePeriodEnd) {
          // 7+ gündür ödenmemiş → suspend
          batches[batches.length - 1].update(sub.ref, {
            status: "expired",
            isSuspendedDueToBilling: true,
            suspendedAt: now,
            updatedAt: now,
          });
          batches[batches.length - 1].update(
            db.collection("users").doc(subData.vendorId),
            {
              isSuspendedDueToBilling: true,
              hasActiveSubscription: false,
              updatedAt: now,
            }
          );
          stats.suspended++;
        } else {
          // Henüz grace period içinde → status: grace_period
          batches[batches.length - 1].update(sub.ref, {
            status: "grace_period",
            updatedAt: now,
          });
          stats.expired++;
        }

        batchCount++;
        if (batchCount >= 250) {
          batches.push(db.batch());
          batchCount = 0;
        }
      }

      for (const b of batches) {
        await b.commit();
      }

      // ─── 2. Trial süresi dolan vendor'lar ───
      console.log("[dailyCron] Step 2: ended trials");
      const trialEndedSnap = await db.collection("vendor_subscriptions")
        .where("isTrial", "==", true)
        .where("trialEndDate", "<", now)
        .limit(500)
        .get();

      for (const sub of trialEndedSnap.docs) {
        const subData = sub.data();
        try {
          await sub.ref.update({
            isTrial: false,
            currentTier: "free",
            status: "active",
            trialEndedAt: now,
            updatedAt: now,
          });
          await db.collection("users").doc(subData.vendorId).update({
            subscriptionTier: "free",
            updatedAt: now,
          });
          stats.trialEnded++;
        } catch (e: any) {
          stats.errors.push(`trial ${subData.vendorId}: ${e.message}`);
        }
      }

      // ─── 3. Günlük featured rotation ───
      console.log("[dailyCron] Step 3: featured rotation");
      const featuredId = today;
      const featuredRef = db.collection("pochub_daily_featured").doc(featuredId);
      const featuredSnap = await featuredRef.get();

      if (!featuredSnap.exists) {
        // Featured oluşturulacak — tier'a göre vendor sıralama
        const vendorsSnap = await db.collection("vendor_subscriptions")
          .where("status", "in", ["active", "grace_period"])
          .get();

        const eligibleVendors: any[] = vendorsSnap.docs
          .map((d) => ({...d.data(), vendorId: d.id}))
          .filter((v: any) => ["professional", "business", "enterprise"].includes(v.currentTier))
          .sort((a: any, b: any) => {
            const tierRank: Record<string, number> = {enterprise: 3, business: 2, professional: 1};
            return (tierRank[b.currentTier] || 0) - (tierRank[a.currentTier] || 0);
          })
          .slice(0, 10);

        const featuredVendors: any[] = [];
        const featuredProducts: any[] = [];

        for (const v of eligibleVendors) {
          const userDoc = await db.collection("users").doc(v.vendorId).get();
          if (!userDoc.exists) continue;
          const user = userDoc.data();
          featuredVendors.push({
            vendorId: v.vendorId,
            vendorName: user?.company || user?.displayName,
            tier: v.currentTier,
            vendorType: user?.vendorType,
          });
          // Vendor'ın 1 ürününü featured'a ekle
          const prodSnap = await db.collection("products")
            .where("vendorId", "==", v.vendorId)
            .where("status", "==", "active")
            .limit(1)
            .get();
          if (!prodSnap.empty) {
            const prod = prodSnap.docs[0].data();
            featuredProducts.push({
              productId: prodSnap.docs[0].id,
              productName: prod.name,
              vendorId: v.vendorId,
              vendorName: user?.company,
              category: prod.category,
              brand: prod.brand,
              unitPrice: prod.unitPrice,
              tier: v.currentTier,
            });
          }
        }

        await featuredRef.set({
          date: featuredId,
          generatedAt: now,
          generatedBy: "dailyMaintenanceCron",
          featuredVendors,
          featuredProducts,
        });
        stats.featuredCreated = featuredVendors.length;
      }

      // ─── 4. AutoRenew adayları ───
      console.log("[dailyCron] Step 4: autoRenew candidates");
      const tomorrow = admin.firestore.Timestamp.fromMillis(nowMs + 86400 * 1000);
      const autoRenewSnap = await db.collection("vendor_subscriptions")
        .where("status", "==", "active")
        .where("autoRenew", "==", true)
        .where("endDate", "<=", tomorrow)
        .where("endDate", ">", now)
        .limit(500)
        .get();

      stats.autoRenewCandidates = autoRenewSnap.size;
      // Gerçek charge v4.79+'da iyzico recurring ile entegre edilecek
      // Şimdilik notification yazıyoruz
      for (const sub of autoRenewSnap.docs) {
        const subData = sub.data();
        await db.collection("notifications").add({
          recipientId: subData.vendorId,
          type: "renewal_upcoming",
          title: "Aboneliğin yarın yenilenecek",
          message: `${subData.currentTier} paketin yarın otomatik yenilenecek.`,
          read: false,
          createdAt: now,
        });
      }

      await markCronComplete(cronType, today, stats);
      console.log("[dailyCron] DONE:", JSON.stringify(stats));
    } catch (e: any) {
      console.error("[dailyCron] FAIL:", e);
      await markCronFailed(cronType, today, e.message || String(e));
      throw e;
    }
  }
);

// ═════════════════════════════════════════════════════════════════════
// hourlyBillingCheckCron — her saat
// ═════════════════════════════════════════════════════════════════════
//
// İşler:
// 1. Cari hesap eşiği aşan vendor'lar → suspension_warning bildirim
// 2. Quota %75/%100'e ulaşan vendor'lar → quota warning bildirim
//
export const hourlyBillingCheckCron = onSchedule(
  {
    schedule: "0 * * * *", // her saat
    timeZone: "UTC",
    region: "europe-west1",
    memory: "256MiB",
    timeoutSeconds: 300,
  },
  async (event) => {
    const hourKey = `${formatDate(new Date())}-${new Date().getUTCHours()}`;
    const cronType = "hourly_billing";

    if (!(await claimCronRun(cronType, hourKey))) {
      return;
    }

    const db = admin.firestore();
    const stats = {
      billingWarnings: 0,
      quotaWarnings: 0,
      errors: [] as string[],
    };

    try {
      // 1. Cari hesap eşiği — config'den oku
      const cfgDoc = await db.collection("pochub_config").doc("system").get();
      const cfg = cfgDoc.data() || {};
      const suspensionThreshold = cfg.creditAccount?.suspensionThreshold || 5000;

      const billingSnap = await db.collection("vendor_billing")
        .where("unpaidBalance", ">=", suspensionThreshold)
        .where("isSuspended", "==", false)
        .limit(200)
        .get();

      for (const billDoc of billingSnap.docs) {
        const bill = billDoc.data();
        const vendorId = bill.vendorId;

        // Son 24 saat içinde uyarı gönderildi mi?
        const recentWarningSnap = await db.collection("notifications")
          .where("recipientId", "==", vendorId)
          .where("type", "==", "suspension_warning")
          .where("createdAt", ">=", admin.firestore.Timestamp.fromMillis(Date.now() - 86400 * 1000))
          .limit(1)
          .get();

        if (!recentWarningSnap.empty) continue; // zaten uyarıldı, skip

        await db.collection("notifications").add({
          recipientId: vendorId,
          type: "suspension_warning",
          title: "Hesap askıya alma uyarısı",
          message: `Cari borcun ₺${bill.unpaidBalance.toLocaleString("tr-TR")}. 7 gün içinde ödenmezse hesap askıya alınacak.`,
          read: false,
          urgency: "high",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        stats.billingWarnings++;
      }

      // 2. Quota warning kontrolü
      const quotaThresholds = cfg.quotaWarnings?.warningPercents || [75, 100];

      const activeSubsSnap = await db.collection("vendor_subscriptions")
        .where("status", "==", "active")
        .limit(500)
        .get();

      // Paket dokümanlarını cache'le (her vendor için tekrar okumamak adına)
      const pkgCache = new Map<string, any>();
      const getPkg = async (id: string) => {
        if (pkgCache.has(id)) return pkgCache.get(id);
        const d = await db.collection("pochub_packages").doc(id).get();
        const v = d.exists ? d.data() : null;
        pkgCache.set(id, v);
        return v;
      };

      for (const subDoc of activeSubsSnap.docs) {
        const sub = subDoc.data();
        const vendorId = subDoc.id;

        // v5.x: Kota modeli client ile AYNI olmalı:
        //   kullanım  = vendor_subscriptions.pocUsedThisCycle  (otorite sayaç)
        //   limit     = pochub_packages.pocQuota               (monthlyPocQuota DEĞİL)
        // Eski kod vendor_billing.currentMonthPocCount + pkg.monthlyPocQuota okuyordu;
        // client bu alanları hiç yazmadığı için kota uyarıları hiç tetiklenmiyordu.
        if (!sub.currentTier || sub.currentTier === "free") continue;

        const pkg = await getPkg(sub.currentPackageId || sub.currentTier);
        const quota = pkg?.pocQuota || 0;
        if (!quota || quota === -1) continue; // -1 = sınırsız (enterprise), 0 = tanımsız → atla

        const used = sub.pocUsedThisCycle || 0;
        const usagePercent = (used / quota) * 100;

        for (const threshold of quotaThresholds) {
          if (usagePercent >= threshold) {
            // Bu eşik için bu ay uyarı gitti mi?
            const monthKey = new Date().toISOString().slice(0, 7); // YYYY-MM
            const warnId = `${vendorId}-quota-${threshold}-${monthKey}`;
            const warnRef = db.collection("notification_dedup").doc(warnId);
            const warnSnap = await warnRef.get();
            if (warnSnap.exists) continue;

            await db.collection("notifications").add({
              recipientId: vendorId,
              type: "quota_warning",
              title: `Kotanın %${threshold}'una ulaştın`,
              message: `Bu ay ${used}/${quota} PoC talebi kullandın (%${Math.round(usagePercent)}).`,
              read: false,
              urgency: threshold >= 100 ? "high" : "normal",
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            await warnRef.set({createdAt: admin.firestore.FieldValue.serverTimestamp()});
            stats.quotaWarnings++;
          }
        }
      }

      await markCronComplete(cronType, hourKey, stats);
      console.log("[hourlyBilling] DONE:", JSON.stringify(stats));
    } catch (e: any) {
      console.error("[hourlyBilling] FAIL:", e);
      await markCronFailed(cronType, hourKey, e.message || String(e));
      throw e;
    }
  }
);

// ═════════════════════════════════════════════════════════════════════
// weeklyDigestCron — Pazartesi 09:00 UTC (TR 12:00)
// ═════════════════════════════════════════════════════════════════════
//
// Admin'lere haftalık özet:
// - MRR (Monthly Recurring Revenue)
// - Yeni vendor sayısı
// - Yeni PoC talepleri
// - Top 5 LTV vendor
// - Churn olan vendor'lar
//
export const weeklyDigestCron = onSchedule(
  {
    schedule: "0 9 * * 1", // her pazartesi 09:00 UTC
    timeZone: "UTC",
    region: "europe-west1",
    memory: "512MiB",
    timeoutSeconds: 540,
  },
  async (event) => {
    const weekKey = formatDate(new Date());
    const cronType = "weekly_digest";

    if (!(await claimCronRun(cronType, weekKey))) {
      return;
    }

    const db = admin.firestore();
    const stats = {
      mrr: 0,
      newVendors: 0,
      newPocs: 0,
      topVendors: [] as any[],
      churned: 0,
    };

    try {
      const now = admin.firestore.Timestamp.now();
      const weekAgo = admin.firestore.Timestamp.fromMillis(Date.now() - 7 * 86400 * 1000);

      // 1. MRR
      const activeSubsSnap = await db.collection("vendor_subscriptions")
        .where("status", "in", ["active", "grace_period"])
        .get();

      for (const sub of activeSubsSnap.docs) {
        const s = sub.data();
        if (s.currentTier === "free" || s.isTrial) continue;
        const pkgDoc = await db.collection("pochub_packages").doc(s.currentPackageId || s.currentTier).get();
        const pkg = pkgDoc.data();
        stats.mrr += pkg?.monthlyPrice || 0;
      }

      // 2. Yeni vendor
      const newVendorsSnap = await db.collection("users")
        .where("role", "==", "vendor")
        .where("createdAt", ">=", weekAgo)
        .get();
      stats.newVendors = newVendorsSnap.size;

      // 3. Yeni PoC
      const newPocsSnap = await db.collection("poc_requests")
        .where("createdAt", ">=", weekAgo)
        .get();
      stats.newPocs = newPocsSnap.size;

      // 4. Top vendor (haftalık tahsilat)
      const histSnap = await db.collection("subscription_history")
        .where("status", "==", "paid")
        .where("paidAt", ">=", weekAgo)
        .get();
      const vendorEarnings: Record<string, number> = {};
      for (const h of histSnap.docs) {
        const d = h.data();
        vendorEarnings[d.vendorId] = (vendorEarnings[d.vendorId] || 0) + (d.amount || 0);
      }
      stats.topVendors = Object.entries(vendorEarnings)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([vendorId, total]) => ({vendorId, total}));

      // 5. Churn (geçen hafta aktif, bu hafta expired)
      const churnedSnap = await db.collection("vendor_subscriptions")
        .where("status", "==", "expired")
        .where("updatedAt", ">=", weekAgo)
        .get();
      stats.churned = churnedSnap.size;

      // 6. Admin'lere bildirim + email (production)
      const adminsSnap = await db.collection("users")
        .where("role", "==", "admin")
        .get();

      for (const admin_doc of adminsSnap.docs) {
        await db.collection("notifications").add({
          recipientId: admin_doc.id,
          type: "weekly_digest",
          title: "Haftalık Özet",
          message: `MRR: ₺${stats.mrr.toLocaleString("tr-TR")} | Yeni vendor: ${stats.newVendors} | Yeni PoC: ${stats.newPocs}`,
          read: false,
          data: stats,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      // Digest snapshot tablosuna kaydet (admin Dashboard için tarihsel veri)
      await db.collection("weekly_digests").doc(weekKey).set({
        weekStartedAt: weekAgo,
        weekEndedAt: now,
        generatedAt: now,
        stats: stats,
      });

      await markCronComplete(cronType, weekKey, stats);
      console.log("[weeklyDigest] DONE:", JSON.stringify(stats));
    } catch (e: any) {
      console.error("[weeklyDigest] FAIL:", e);
      await markCronFailed(cronType, weekKey, e.message || String(e));
      throw e;
    }
  }
);

// ═════════════════════════════════════════════════════════════════════
// v4.97: cycleResetCron — her gün 04:00 UTC (TR 07:00)
// ═════════════════════════════════════════════════════════════════════
//
// İş: vendor_subscriptions için 30 günü dolan cycle'ları reset eder.
// pocUsedThisCycle = 0, cycleStartedAt = now, lastCycleResetAt = now
// referralBonusPocs ASLA SIFIRLANMAZ (kalıcı kazanım - v4.96 ile uyumlu).
//
// Backup mekanizma: Client-side reset (v4.96) zaten var ama vendor pasifse
// hiç tetiklenmez. Bu cron her gün sweep yaparak güvence verir.
//
export const cycleResetCron = onSchedule(
  {
    schedule: "0 4 * * *", // her gün 04:00 UTC
    timeZone: "UTC",
    region: "europe-west1",
    memory: "512MiB",
    timeoutSeconds: 540,
  },
  async (event) => {
    const today = formatDate(new Date());
    const cronType = "cycle_reset";

    if (!(await claimCronRun(cronType, today))) {
      return;
    }

    const db = admin.firestore();
    const stats = {
      checked: 0,
      reset: 0,
      bonusPreserved: 0,
      errors: [] as string[],
    };

    try {
      const now = admin.firestore.Timestamp.now();
      const thirtyDaysAgoMs = Date.now() - 30 * 86400 * 1000;
      const cutoff = admin.firestore.Timestamp.fromMillis(thirtyDaysAgoMs);

      // cycleStartedAt 30+ gün önceki active subscription'lar
      const oldCycleSnap = await db.collection("vendor_subscriptions")
        .where("status", "in", ["active", "grace_period"])
        .where("cycleStartedAt", "<=", cutoff)
        .limit(500)
        .get();

      stats.checked = oldCycleSnap.size;

      const batch = db.batch();
      let batchCount = 0;
      const batches: admin.firestore.WriteBatch[] = [batch];

      for (const sub of oldCycleSnap.docs) {
        const subData = sub.data();
        const oldBonus = subData.referralBonusPocs || 0;

        // Reset - pocUsedThisCycle 0, cycleStartedAt now
        // referralBonusPocs DOKUNULMUYOR (kalıcı kazanım)
        batches[batches.length - 1].update(sub.ref, {
          pocUsedThisCycle: 0,
          inviteUsedThisCycle: 0,  // davet kotası da reset
          cycleStartedAt: now,
          lastCycleResetAt: now,
          // referralBonusPocs: KORUNUR
        });

        if (oldBonus > 0) stats.bonusPreserved++;
        stats.reset++;

        batchCount++;
        if (batchCount >= 250) {
          batches.push(db.batch());
          batchCount = 0;
        }
      }

      for (const b of batches) {
        await b.commit();
      }

      await markCronComplete(cronType, today, stats);
      console.log("[cycleReset] DONE:", JSON.stringify(stats));
    } catch (e: any) {
      console.error("[cycleReset] FAIL:", e);
      await markCronFailed(cronType, today, e.message || String(e));
      throw e;
    }
  }
);
