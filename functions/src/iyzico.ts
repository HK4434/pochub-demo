/**
 * PoCHub Functions - iyzico Payment Integration
 * v4.76 - Phase 2.6
 *
 * Exports:
 *  - iyzicoCheckoutInit  (callable) — vendor ödemeyi başlatır
 *  - iyzicoCallback      (HTTP)     — iyzico ödeme sonucu döner
 *
 * Secrets gerekli:
 *  - IYZICO_API_KEY
 *  - IYZICO_SECRET_KEY
 *  - IYZICO_BASE_URL (default: sandbox)
 */

import * as admin from "firebase-admin";
import {onCall, onRequest} from "firebase-functions/v2/https";
import {defineSecret} from "firebase-functions/params";
import {requireAuth, requireFields, requireNumber, ok, handleError, auditLog} from "./helpers";
import {
  checkoutInitialize,
  checkoutRetrieve,
  formatPrice,
  IyzicoConfig,
} from "./iyzico-client";

// Secrets (Firebase Secret Manager)
const IYZICO_API_KEY = defineSecret("IYZICO_API_KEY");
const IYZICO_SECRET_KEY = defineSecret("IYZICO_SECRET_KEY");
const IYZICO_BASE_URL = defineSecret("IYZICO_BASE_URL");

// ─────────────────────────────────────────────────────────────────────
// iyzicoCheckoutInit — Vendor ödeme başlatır
// ─────────────────────────────────────────────────────────────────────
//
// Input: { packageId, billingMode, durationDays, amount, autoRenew, saveCard }
// Output: { token, checkoutFormContent, paymentPageUrl }
//
// Akış:
// 1. Auth + vendor kontrolü
// 2. Paket/fiyat doğrulama (frontend'den gelen amount güvenilmez)
// 3. Vendor profili oku → buyer bilgileri hazırla
// 4. subscription_history kaydı oluştur (status: 'pending')
// 5. iyzico Checkout Form Initialize çağır
// 6. Token + checkoutFormContent geri döndür
//
export const iyzicoCheckoutInit = onCall(
  {
    secrets: [IYZICO_API_KEY, IYZICO_SECRET_KEY, IYZICO_BASE_URL],
    timeoutSeconds: 60,
    memory: "256MiB",
  },
  async (request) => {
    try {
      const uid = requireAuth(request);
      requireFields(request.data, ["packageId", "billingMode", "durationDays", "amount"]);

      const packageId = String(request.data.packageId);
      const billingMode = String(request.data.billingMode);
      const durationDays = requireNumber(request.data.durationDays, "durationDays", {min: 1, integer: true});
      const requestedAmount = requireNumber(request.data.amount, "amount", {min: 0});
      const autoRenew = !!request.data.autoRenew;
      const saveCard = !!request.data.saveCard;

      const db = admin.firestore();

      // 1. Paket bilgisini sunucudan oku (güvenlik)
      const pkgDoc = await db.collection("pochub_packages").doc(packageId).get();
      if (!pkgDoc.exists) {
        throw new Error(`Paket bulunamadı: ${packageId}`);
      }
      const pkg = pkgDoc.data();

      // 2. Fiyat doğrulama — frontend manipülasyonuna karşı
      let serverAmount = 0;
      if (billingMode === "monthly") serverAmount = pkg?.monthlyPrice || 0;
      else if (billingMode === "yearly") serverAmount = pkg?.yearlyPrice || 0;
      else throw new Error(`Geçersiz billingMode: ${billingMode}`);

      if (serverAmount <= 0) {
        throw new Error("Bu paket için ücretsiz mod aktif. Doğrudan aktive et.");
      }

      // ±%5 tolerans (config-driven discount vb. için)
      if (Math.abs(requestedAmount - serverAmount) / serverAmount > 0.05) {
        await auditLog(uid, "iyzico_price_mismatch", {
          packageId,
          billingMode,
          requested: requestedAmount,
          actual: serverAmount,
        });
        throw new Error(`Fiyat uyumsuz. Beklenen: ${serverAmount}, gelen: ${requestedAmount}`);
      }

      // 3. Vendor profili
      const userDoc = await db.collection("users").doc(uid).get();
      if (!userDoc.exists) {
        throw new Error("Kullanıcı profili bulunamadı");
      }
      const user = userDoc.data();
      if (user?.role !== "vendor") {
        throw new Error("Sadece vendor'lar ödeme yapabilir");
      }

      // 4. subscription_history pending kaydı
      const conversationId = `pch-${uid.slice(0, 6)}-${Date.now()}`;

      // Callback URL (Functions v2 URL formatı)
      const projectId = process.env.GCLOUD_PROJECT || "pochub-co";
      const callbackUrl = `https://europe-west1-${projectId}.cloudfunctions.net/iyzicoCallback`;

      // 5. iyzico'ya istek hazırla
      const iyzicoConfig: IyzicoConfig = {
        apiKey: IYZICO_API_KEY.value(),
        secretKey: IYZICO_SECRET_KEY.value(),
        baseUrl: IYZICO_BASE_URL.value() || "https://sandbox-api.iyzipay.com",
      };

      const buyerName = (user?.displayName || user?.company || user?.email || "PoCHub Vendor").split(" ");
      const firstName = buyerName[0] || "PoCHub";
      const lastName = buyerName.slice(1).join(" ") || "Vendor";

      const iyzicoResp = await checkoutInitialize(iyzicoConfig, {
        conversationId: conversationId,
        price: formatPrice(serverAmount),
        paidPrice: formatPrice(serverAmount),
        currency: "TRY",
        basketId: packageId,
        paymentGroup: autoRenew ? "SUBSCRIPTION" : "PRODUCT",
        callbackUrl: callbackUrl,
        enabledInstallments: [1, 2, 3, 6, 9, 12],
        buyer: {
          id: uid,
          name: firstName,
          surname: lastName,
          gsmNumber: user?.phone || "+905555555555",
          email: user?.email || "noreply@pochub.co",
          identityNumber: user?.invoiceTaxNumber || "11111111111",
          registrationAddress: user?.invoiceAddress || "İstanbul, Türkiye",
          ip: (request.rawRequest?.ip as string) || "127.0.0.1",
          city: user?.city || "İstanbul",
          country: "Turkey",
          zipCode: user?.zipCode || "34000",
        },
        shippingAddress: {
          contactName: user?.invoiceCompanyName || user?.company || "PoCHub Vendor",
          city: user?.city || "İstanbul",
          country: "Turkey",
          address: user?.invoiceAddress || "İstanbul, Türkiye",
          zipCode: user?.zipCode || "34000",
        },
        billingAddress: {
          contactName: user?.invoiceCompanyName || user?.company || "PoCHub Vendor",
          city: user?.city || "İstanbul",
          country: "Turkey",
          address: user?.invoiceAddress || "İstanbul, Türkiye",
          zipCode: user?.zipCode || "34000",
        },
        basketItems: [{
          id: packageId,
          name: pkg?.name || "PoCHub Paket",
          category1: "SaaS Aboneliği",
          itemType: "VIRTUAL",
          price: formatPrice(serverAmount),
        }],
      });

      if (iyzicoResp.status !== "success" || !iyzicoResp.token) {
        await auditLog(uid, "iyzico_init_failed", {
          conversationId,
          errorCode: iyzicoResp.errorCode,
          errorMessage: iyzicoResp.errorMessage,
        });
        throw new Error(`iyzico hatası: ${iyzicoResp.errorMessage || iyzicoResp.errorCode}`);
      }

      // 6. subscription_history pending kaydı (token ile)
      await db.collection("subscription_history").add({
        vendorId: uid,
        vendorName: user?.company || user?.email || "Vendor",
        packageId: packageId,
        packageName: pkg?.name || "Paket",
        action: "purchase",
        fromPackageId: null,
        toPackageId: packageId,
        amount: serverAmount,
        currency: "TRY",
        billingMode: billingMode,
        durationDays: durationDays,
        paymentMethod: "credit_card",
        paymentProvider: "iyzico",
        status: "pending",
        iyzicoToken: iyzicoResp.token,
        iyzicoConversationId: conversationId,
        autoRenew: autoRenew,
        saveCardOnSuccess: saveCard,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await auditLog(uid, "iyzico_init_success", {
        conversationId,
        token: iyzicoResp.token,
        amount: serverAmount,
      });

      // 7. Client'a ihtiyaç duyduğu HTML+JS snippet'i döndür
      return ok({
        token: iyzicoResp.token,
        checkoutFormContent: iyzicoResp.checkoutFormContent,
        paymentPageUrl: iyzicoResp.paymentPageUrl,
        conversationId: conversationId,
      });
    } catch (e) {
      handleError(e, "iyzicoCheckoutInit");
    }
  }
);

// ─────────────────────────────────────────────────────────────────────
// iyzicoCallback — iyzico ödeme sonucu döner (HTTP webhook)
// ─────────────────────────────────────────────────────────────────────
//
// iyzico POST eder: token=...&status=success|failure&...
// Bizim işimiz:
// 1. Token ile checkoutRetrieve çağır → ödeme detaylarını doğrula
// 2. subscription_history kaydını bul → status güncelle
// 3. status: paid ise vendor_subscriptions tablosunu da güncelle
// 4. Vendor'a HTML response döndür (browser sayfayı kapatabilir)
//
export const iyzicoCallback = onRequest(
  {
    secrets: [IYZICO_API_KEY, IYZICO_SECRET_KEY, IYZICO_BASE_URL],
    timeoutSeconds: 60,
    memory: "256MiB",
    region: "europe-west1",
  },
  async (req, res) => {
    try {
      // iyzico POST form data ile gönderiyor
      const token = req.body?.token as string | undefined;
      if (!token) {
        res.status(400).send(callbackHtml("Token eksik", false));
        return;
      }

      const iyzicoConfig: IyzicoConfig = {
        apiKey: IYZICO_API_KEY.value(),
        secretKey: IYZICO_SECRET_KEY.value(),
        baseUrl: IYZICO_BASE_URL.value() || "https://sandbox-api.iyzipay.com",
      };

      // 1. iyzico'dan detayları çek
      const detail = await checkoutRetrieve(iyzicoConfig, token);

      const db = admin.firestore();

      // 2. subscription_history kaydını bul
      const histSnap = await db.collection("subscription_history")
        .where("iyzicoToken", "==", token)
        .limit(1)
        .get();

      if (histSnap.empty) {
        console.error(`iyzicoCallback: history bulunamadı, token=${token}`);
        res.status(404).send(callbackHtml("İşlem kaydı bulunamadı", false));
        return;
      }

      const histDoc = histSnap.docs[0];
      const histData = histDoc.data();
      const vendorId = histData.vendorId;
      const packageId = histData.packageId;
      const durationDays = histData.durationDays || 30;

      // 3. Ödeme sonucunu kontrol et
      const isSuccess = detail.status === "success" && detail.paymentStatus === "SUCCESS";

      if (isSuccess) {
        // Başarılı — kayıtları güncelle
        const updates: any = {
          status: "paid",
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
          iyzicoPaymentId: detail.paymentId,
          cardLast4: detail.lastFourDigits,
          cardBrand: detail.cardAssociation,
          installment: detail.installment || 1,
          binNumber: detail.binNumber,
        };
        await histDoc.ref.update(updates);

        // vendor_subscriptions güncelle
        const subRef = db.collection("vendor_subscriptions").doc(vendorId);
        const subSnap = await subRef.get();
        const now = admin.firestore.Timestamp.now();
        const endDate = admin.firestore.Timestamp.fromMillis(
          Date.now() + durationDays * 86400000
        );

        if (subSnap.exists) {
          await subRef.update({
            currentTier: packageId,
            status: "active",
            startDate: now,
            endDate: endDate,
            autoRenew: histData.autoRenew || false,
            lastPaymentAt: now,
            isSuspendedDueToBilling: false,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        } else {
          await subRef.set({
            vendorId: vendorId,
            currentTier: packageId,
            status: "active",
            startDate: now,
            endDate: endDate,
            autoRenew: histData.autoRenew || false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            lastPaymentAt: now,
            isTrial: false,
          });
        }

        // users tablosunu da güncelle (denormalized)
        await db.collection("users").doc(vendorId).update({
          subscriptionTier: packageId,
          hasActiveSubscription: true,
          isSuspendedDueToBilling: false,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Kart kaydet (eğer istenmişse)
        if (histData.saveCardOnSuccess && detail.lastFourDigits) {
          await db.collection("payment_methods").doc(vendorId).set({
            vendorId: vendorId,
            preferredMethod: "iyzico",
            iyzico: {
              last4: detail.lastFourDigits,
              cardBrand: detail.cardAssociation,
              binNumber: detail.binNumber,
              cardFamily: detail.cardFamily,
              addedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, {merge: true});
        }

        await auditLog(vendorId, "iyzico_payment_success", {
          token,
          paymentId: detail.paymentId,
          amount: histData.amount,
        });

        res.status(200).send(callbackHtml("✅ Ödeme başarılı! Paketiniz aktive edildi.", true));
      } else {
        // Başarısız
        await histDoc.ref.update({
          status: "failed",
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
          failReason: detail.errorMessage || `paymentStatus: ${detail.paymentStatus}`,
          iyzicoErrorCode: detail.errorCode,
        });

        await auditLog(vendorId, "iyzico_payment_failed", {
          token,
          errorCode: detail.errorCode,
          errorMessage: detail.errorMessage,
        });

        res.status(200).send(callbackHtml(
          `❌ Ödeme başarısız: ${detail.errorMessage || "Bilinmeyen hata"}`,
          false
        ));
      }
    } catch (e: any) {
      console.error("iyzicoCallback error:", e);
      res.status(500).send(callbackHtml(`Sunucu hatası: ${e.message}`, false));
    }
  }
);

// ─────────────────────────────────────────────────────────────────────
// HTML response helper
// ─────────────────────────────────────────────────────────────────────

function callbackHtml(message: string, success: boolean): string {
  const color = success ? "#22d078" : "#dc2626";
  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <title>iyzico Ödeme Sonucu</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           background: #0a0d14; color: #fff; display: flex; align-items: center;
           justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
    .card { background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.1);
            border-radius: 16px; padding: 32px; max-width: 420px; text-align: center; }
    .icon { font-size: 64px; margin-bottom: 16px; }
    h2 { color: ${color}; margin: 0 0 12px; font-size: 20px; }
    p { color: rgba(255,255,255,.7); margin: 0 0 24px; font-size: 14px; line-height: 1.6; }
    .btn { background: ${color}; color: white; border: none; padding: 12px 24px;
           border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer;
           text-decoration: none; display: inline-block; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${success ? "🎉" : "⚠️"}</div>
    <h2>${success ? "Ödeme Başarılı" : "Ödeme Başarısız"}</h2>
    <p>${message}</p>
    <p style="font-size:12px;margin-top:16px;color:rgba(255,255,255,.4)">Bu pencere otomatik kapanacak. PoCHub sayfasına geri dönün.</p>
    <button class="btn" onclick="window.close()">Pencereyi Kapat</button>
  </div>
  <script>
    setTimeout(function(){ try { window.close(); } catch(e) {} }, 5000);
  </script>
</body>
</html>`;
}
