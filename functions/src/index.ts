/**
 * PoCHub Firebase Functions - Entry Point
 * v4.75 - Phase 2.5
 *
 * Region: europe-west1 (Türkiye'ye en yakın)
 * Runtime: Node.js 20
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

// ─── v4.76: iyzico ödeme entegrasyonu (PLACEHOLDER) ──────────────────
// export {iyzicoCheckoutInit} from "./iyzico";
// export {iyzicoCallback} from "./iyzico";
// export {iyzicoTokenizeCard} from "./iyzico";

// ─── v4.77: EmailJS bildirimler (PLACEHOLDER) ────────────────────────
// export {sendNotificationEmail} from "./email";
// export {sendInvoiceEmail} from "./email";

// ─── v4.78: Scheduled cron jobs (PLACEHOLDER) ────────────────────────
// export {dailyMaintenanceCron} from "./cron";

// ─── v4.79+: Production fonksiyonları (PLACEHOLDER) ──────────────────
// export {createPocCharge} from "./charges";
// export {approvePocCharge} from "./charges";
// export {grantOverride} from "./overrides";
