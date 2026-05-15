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

// ─── v4.77: EmailJS bildirimler (PLACEHOLDER) ────────────────────────
// export {sendNotificationEmail} from "./email";
// export {sendInvoiceEmail} from "./email";

// ─── v4.78: Scheduled cron jobs (PLACEHOLDER) ────────────────────────
// export {dailyMaintenanceCron} from "./cron";

// ─── v4.79+: Production fonksiyonları (PLACEHOLDER) ──────────────────
// export {createPocCharge} from "./charges";
// export {approvePocCharge} from "./charges";
// export {grantOverride} from "./overrides";
