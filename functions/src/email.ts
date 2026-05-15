/**
 * PoCHub Functions - Email Notifications (server-side EmailJS)
 * v4.77 - Phase 2.7
 *
 * Exports:
 *  - sendNotificationEmail (callable) — herhangi bir template gönder
 *  - sendInvoiceEmail      (callable) — ödeme sonrası fatura PDF link mail
 *
 * Secrets gerekli:
 *  - EMAILJS_SERVICE_ID
 *  - EMAILJS_USER_ID       (public key)
 *  - EMAILJS_PRIVATE_KEY   (private key - server-side only)
 *
 * EmailJS REST API V1.0 docs:
 *   https://www.emailjs.com/docs/rest-api/send/
 *
 * NOT: EmailJS'in resmi Node SDK'sı yok. Native fetch ile yapıyoruz.
 *
 * Rate limiting:
 *   - Vendor başına/saatte max 10 mail (audit_log üzerinden)
 *   - Bypass etmek için admin role gerekir
 */

import * as admin from "firebase-admin";
import {onCall} from "firebase-functions/v2/https";
import {defineSecret} from "firebase-functions/params";
import {requireAuth, requireFields, ok, handleError, auditLog} from "./helpers";

// Secrets
const EMAILJS_SERVICE_ID = defineSecret("EMAILJS_SERVICE_ID");
const EMAILJS_USER_ID = defineSecret("EMAILJS_USER_ID");
const EMAILJS_PRIVATE_KEY = defineSecret("EMAILJS_PRIVATE_KEY");

// ─────────────────────────────────────────────────────────────────────
// TEMPLATE REGISTRY
// ─────────────────────────────────────────────────────────────────────
// 7 ana template tipi. Production'da EmailJS dashboard'da 7 ayrı template
// oluşturulmalı ve ID'leri buraya yazılmalı.

interface TemplateMeta {
  emailJsTemplateId: string;
  subject: string;
  requiredVars: string[];
  description: string;
}

const TEMPLATES: Record<string, TemplateMeta> = {
  package_activated: {
    emailJsTemplateId: "template_pkg_active",
    subject: "PoCHub — Paketin aktif!",
    requiredVars: ["to_email", "to_name", "package_name", "expires_at"],
    description: "Paket satın alma sonrası teşekkür + aktivasyon onayı",
  },
  payment_received: {
    emailJsTemplateId: "template_pay_received",
    subject: "PoCHub — Ödemen alındı",
    requiredVars: ["to_email", "to_name", "amount", "payment_method", "receipt_no"],
    description: "Başarılı ödeme tahsilat onayı",
  },
  payment_failed: {
    emailJsTemplateId: "template_pay_failed",
    subject: "PoCHub — Ödemen başarısız oldu",
    requiredVars: ["to_email", "to_name", "amount", "reason"],
    description: "Ödeme reddedildi/timeout/insufficient funds",
  },
  invoice_ready: {
    emailJsTemplateId: "template_invoice",
    subject: "PoCHub — Makbuzun hazır",
    requiredVars: ["to_email", "to_name", "receipt_no", "amount", "invoice_url"],
    description: "PDF makbuz/fatura linki",
  },
  suspension_warning: {
    emailJsTemplateId: "template_suspension",
    subject: "PoCHub — Hesap askıya alma uyarısı",
    requiredVars: ["to_email", "to_name", "unpaid_balance", "due_date"],
    description: "Cari hesap borç eşiği aşıldı, X gün sonra askıya alınacak",
  },
  override_granted: {
    emailJsTemplateId: "template_override",
    subject: "PoCHub — Override talebin onaylandı",
    requiredVars: ["to_email", "to_name", "vendor_name", "poc_count"],
    description: "Admin manuel paket override verdiğinde",
  },
  vendor_approved: {
    emailJsTemplateId: "template_vendor_approved",
    subject: "PoCHub — Vendor başvurun onaylandı",
    requiredVars: ["to_email", "to_name", "company_name"],
    description: "Vendor başvuru onayı (admin tarafından)",
  },
  generic: {
    emailJsTemplateId: "template_generic",
    subject: "PoCHub bildirimi",
    requiredVars: ["to_email", "message"],
    description: "Genel amaçlı bildirim — özelleşmiş template yoksa fallback",
  },
};

// ─────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * Vendor başına/saatte max N email rate limit.
 * audit_log'da son 1 saat içindeki email aksiyonlarını sayar.
 */
async function checkRateLimit(uid: string, limit: number = 10): Promise<RateLimitResult> {
  const db = admin.firestore();
  const oneHourAgo = admin.firestore.Timestamp.fromMillis(Date.now() - 3600 * 1000);

  const snap = await db.collection("audit_log")
    .where("uid", "==", uid)
    .where("action", "==", "email_sent")
    .where("timestamp", ">=", oneHourAgo)
    .get();

  const used = snap.size;
  return {
    allowed: used < limit,
    remaining: Math.max(0, limit - used),
    resetAt: Date.now() + 3600 * 1000,
  };
}

/**
 * EmailJS REST API çağırır.
 * https://www.emailjs.com/docs/rest-api/send/
 */
async function emailJsSend(
  serviceId: string,
  templateId: string,
  userId: string,
  accessToken: string,
  templateParams: Record<string, any>
): Promise<{ok: boolean; status: number; body: string}> {
  const response = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      service_id: serviceId,
      template_id: templateId,
      user_id: userId,
      accessToken: accessToken, // private key (server-side only)
      template_params: templateParams,
    }),
  });

  const body = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    body: body,
  };
}

// ─────────────────────────────────────────────────────────────────────
// sendNotificationEmail (callable)
// ─────────────────────────────────────────────────────────────────────
//
// Input:
//   {
//     templateType: 'package_activated' | 'payment_received' | ... ,
//     vars: { to_email, to_name, ...template specific }
//   }
//
// Output:
//   { ok, data: { messageId, mode: 'production', remaining_rate } }
//
export const sendNotificationEmail = onCall(
  {
    secrets: [EMAILJS_SERVICE_ID, EMAILJS_USER_ID, EMAILJS_PRIVATE_KEY],
    timeoutSeconds: 30,
    memory: "256MiB",
  },
  async (request) => {
    try {
      const uid = requireAuth(request);
      requireFields(request.data, ["templateType", "vars"]);

      const templateType = String(request.data.templateType);
      const vars = request.data.vars as Record<string, any>;

      // 1. Template doğrulama
      const tmpl = TEMPLATES[templateType];
      if (!tmpl) {
        throw new Error(`Bilinmeyen template: ${templateType}`);
      }

      // 2. Required vars kontrolü
      for (const requiredVar of tmpl.requiredVars) {
        if (!vars[requiredVar]) {
          throw new Error(`${templateType} için eksik alan: ${requiredVar}`);
        }
      }

      // 3. Rate limit (admin değilse)
      const db = admin.firestore();
      const userDoc = await db.collection("users").doc(uid).get();
      const userRole = userDoc.data()?.role;

      if (userRole !== "admin") {
        const rate = await checkRateLimit(uid, 10);
        if (!rate.allowed) {
          throw new Error(`Rate limit: saatte max 10 email. Reset: ${new Date(rate.resetAt).toISOString()}`);
        }
      }

      // 4. EmailJS gönder
      const sendResult = await emailJsSend(
        EMAILJS_SERVICE_ID.value(),
        tmpl.emailJsTemplateId,
        EMAILJS_USER_ID.value(),
        EMAILJS_PRIVATE_KEY.value(),
        {
          ...vars,
          subject: tmpl.subject,
        }
      );

      // 5. Log + audit
      await db.collection("email_log").add({
        sentBy: uid,
        templateType: templateType,
        emailJsTemplateId: tmpl.emailJsTemplateId,
        toEmail: vars.to_email,
        status: sendResult.ok ? "sent" : "failed",
        statusCode: sendResult.status,
        responseBody: sendResult.body.slice(0, 500),
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await auditLog(uid, "email_sent", {
        templateType,
        to: vars.to_email,
        success: sendResult.ok,
      });

      if (!sendResult.ok) {
        throw new Error(`EmailJS hatası (${sendResult.status}): ${sendResult.body}`);
      }

      return ok({
        sent: true,
        templateType,
        to: vars.to_email,
        mode: "production",
      });
    } catch (e) {
      handleError(e, "sendNotificationEmail");
    }
  }
);

// ─────────────────────────────────────────────────────────────────────
// sendInvoiceEmail (callable) — fatura/makbuz PDF link mail
// ─────────────────────────────────────────────────────────────────────
//
// Input: { historyId, invoiceUrl }
// Output: { ok, data: { sent, to } }
//
// NOT: invoiceUrl şu an PDF'in CDN URL'i olmalı. v4.74'te PDF client-side
// jsPDF ile üretiliyor → vendor kendi indiriyor. Bu function şimdilik
// "link mail" formatı kullanır; gelecekte PDF'i base64 ile attach edebilir.
//
export const sendInvoiceEmail = onCall(
  {
    secrets: [EMAILJS_SERVICE_ID, EMAILJS_USER_ID, EMAILJS_PRIVATE_KEY],
    timeoutSeconds: 30,
    memory: "256MiB",
  },
  async (request) => {
    try {
      const uid = requireAuth(request);
      requireFields(request.data, ["historyId"]);

      const historyId = String(request.data.historyId);
      const invoiceUrl = request.data.invoiceUrl || "";

      const db = admin.firestore();

      // 1. subscription_history kaydını al
      const histDoc = await db.collection("subscription_history").doc(historyId).get();
      if (!histDoc.exists) {
        throw new Error("Geçmiş kaydı bulunamadı");
      }
      const hist = histDoc.data();

      // 2. Yetki kontrolü — sadece kayıt sahibi veya admin
      const userDoc = await db.collection("users").doc(uid).get();
      const isAdmin = userDoc.data()?.role === "admin";
      if (!isAdmin && hist?.vendorId !== uid) {
        throw new Error("Bu makbuza erişim yetkin yok");
      }

      // 3. Vendor email
      const vendorDoc = await db.collection("users").doc(hist?.vendorId).get();
      const vendorEmail = vendorDoc.data()?.email;
      if (!vendorEmail) {
        throw new Error("Vendor email bulunamadı");
      }

      // 4. Makbuz no üret (deterministik)
      const dt = hist?.paidAt?.toDate ? hist.paidAt.toDate() : new Date();
      const year = dt.getFullYear();
      const shortId = historyId.slice(-6).toUpperCase();
      const receiptNo = `PCH-${year}-${shortId}`;

      // 5. Mail gönder
      const sendResult = await emailJsSend(
        EMAILJS_SERVICE_ID.value(),
        TEMPLATES.invoice_ready.emailJsTemplateId,
        EMAILJS_USER_ID.value(),
        EMAILJS_PRIVATE_KEY.value(),
        {
          to_email: vendorEmail,
          to_name: vendorDoc.data()?.displayName || vendorDoc.data()?.company || "Vendor",
          receipt_no: receiptNo,
          amount: hist?.amount?.toFixed(2) || "0.00",
          invoice_url: invoiceUrl || "PoCHub'da görüntüle",
          subject: TEMPLATES.invoice_ready.subject,
        }
      );

      // 6. Log
      await db.collection("email_log").add({
        sentBy: uid,
        templateType: "invoice_ready",
        emailJsTemplateId: TEMPLATES.invoice_ready.emailJsTemplateId,
        toEmail: vendorEmail,
        relatedHistoryId: historyId,
        receiptNo: receiptNo,
        status: sendResult.ok ? "sent" : "failed",
        statusCode: sendResult.status,
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await auditLog(uid, "invoice_email_sent", {
        historyId,
        receiptNo,
        to: vendorEmail,
        success: sendResult.ok,
      });

      if (!sendResult.ok) {
        throw new Error(`EmailJS hatası: ${sendResult.body}`);
      }

      return ok({
        sent: true,
        to: vendorEmail,
        receiptNo: receiptNo,
      });
    } catch (e) {
      handleError(e, "sendInvoiceEmail");
    }
  }
);
