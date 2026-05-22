/**
 * PoCHub Firebase Functions - Entry Point
 * v4.76 - Phase 2.6
 *
 * Region: europe-west1 (Türkiye'ye en yakın)
 * Runtime: Node.js 22
 */

import * as admin from "firebase-admin";
import {setGlobalOptions} from "firebase-functions/v2";

// Firebase Admin SDK init (sadece bir kez)
admin.initializeApp();

// Tüm function'lar için ortak ayarlar
setGlobalOptions({
  region: "europe-west1",
  memory: "256MiB",
  timeoutSeconds: 60,
  maxInstances: 10, // güvenlik amaçlı maks scale limit
});

// ═════════════════════════════════════════════════════════════════════
// FUNCTION EXPORTS
// ═════════════════════════════════════════════════════════════════════

// ─── v4.75: Starter functions (test + sağlık kontrolü) ───────────────
export {helloWorld} from "./hello";
export {getServerTime} from "./hello";
export {getCurrentUser} from "./hello";

// ─── v4.76: iyzico ödeme entegrasyonu (AKTİF) ────────────────────────
// Bu function'ları kullanmak için:
//   1. Blaze plan aktif olmalı
//   2. firebase functions:secrets:set IYZICO_API_KEY
//   3. firebase functions:secrets:set IYZICO_SECRET_KEY
//   4. firebase functions:secrets:set IYZICO_BASE_URL
//   5. firebase deploy --only functions:iyzicoCheckoutInit,functions:iyzicoCallback
//   6. HTML'de USE_PRODUCTION_PAYMENTS = true yap
export {iyzicoCheckoutInit} from "./iyzico";
export {iyzicoCallback} from "./iyzico";

// ─── v4.77: EmailJS bildirimler (AKTİF) ──────────────────────────────
// Production'da çalışması için:
//   1. EmailJS hesabı + 7 template oluştur (template_pkg_active, template_pay_received, vs.)
//   2. firebase functions:secrets:set EMAILJS_SERVICE_ID
//   3. firebase functions:secrets:set EMAILJS_USER_ID
//   4. firebase functions:secrets:set EMAILJS_PRIVATE_KEY
//   5. firebase deploy --only functions:sendNotificationEmail,functions:sendInvoiceEmail
//   6. HTML'de USE_PRODUCTION_EMAIL = true yap
export {sendNotificationEmail} from "./email";
export {sendInvoiceEmail} from "./email";

// ─── v4.78: Scheduled cron jobs (AKTİF) ──────────────────────────────
// Cloud Scheduler ile tetiklenir, Blaze plan gerekir.
// Deploy:
//   firebase deploy --only functions:dailyMaintenanceCron,functions:hourlyBillingCheckCron,functions:weeklyDigestCron
// Manual tetikleme (test):
//   gcloud scheduler jobs run firebase-schedule-dailyMaintenanceCron-europe-west1 --location=europe-west1
export {dailyMaintenanceCron} from "./cron";
export {hourlyBillingCheckCron} from "./cron";
export {weeklyDigestCron} from "./cron";

// ─── v4.97: Cycle reset cron (AKTİF) ─────────────────────────────────
// Her gün 04:00 UTC çalışır.
// 30 günü dolan vendor cycle'larını reset eder, referralBonusPocs korunur.
// Client-side reset (v4.96) yedek olarak çalışmaya devam eder.
// Deploy:
//   firebase deploy --only functions:cycleResetCron
export {cycleResetCron} from "./cron";

// ─── v4.97: Calendly webhook (AKTİF) ─────────────────────────────────
// HTTP endpoint - Calendly randevu event'lerini dinler.
// Setup:
//   1. firebase functions:secrets:set CALENDLY_SIGNING_KEY
//      (Calendly Webhook ayarlarından signing key kopyala)
//   2. firebase deploy --only functions:calendlyWebhook
//   3. Calendly'de webhook URL ekle:
//      https://europe-west1-pochub-co.cloudfunctions.net/calendlyWebhook
//   4. Events: invitee.created, invitee.canceled
//
// Client-side postMessage (v4.90) ile hibrit çalışır:
//   - Kullanıcı embed widget'te randevu alırsa → postMessage tetiklenir
//   - Kullanıcı sayfayı kapatıp Calendly'den randevu alırsa → webhook tetiklenir
//   - Her iki durumda demo_requests doc güncellenir
export {calendlyWebhook} from "./calendly-webhook";

// ─── v4.79+: Production fonksiyonları (PLACEHOLDER) ──────────────────
// export {createPocCharge} from "./charges";
// export {approvePocCharge} from "./charges";
// export {grantOverride} from "./overrides";
