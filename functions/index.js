"use strict";

/**
 * PoCHub — Cloud Functions (2. nesil) · EmailJS bildirimleri
 * Bölge: europe-west1 · Node 20
 *
 * Güvenlik notu: Bu fonksiyonlar e-postayı SUNUCUDA, gerçek Firestore
 * olaylarından tetikleyerek gönderir. İstemci e-posta "kuyruğu" yazmaz;
 * bu yüzden spam/forge riski yoktur. EmailJS kimlik bilgileri koda
 * gömülmez → Secret Manager (defineSecret).
 *
 * ÖN KOŞUL (EmailJS panel → Account → Security):
 *   "Allow EmailJS API for non-browser applications" AÇIK olmalı,
 *   ve private key (accessToken) ile çağrı yapılmalı (aşağıda yapılıyor).
 */

const { setGlobalOptions } = require("firebase-functions/v2");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const emailjs = require("@emailjs/nodejs");

admin.initializeApp();

// ── Global ayarlar: bölge + MALİYET korumaları ──
// minInstances varsayılan 0 (boşta maliyet yok). maxInstances kaçak faturayı engeller.
setGlobalOptions({ region: "europe-west1", maxInstances: 5, memory: "256MiB" });

// ── Sırlar (Cloud Shell: firebase functions:secrets:set ...) ──
const EMAILJS_SERVICE_ID = defineSecret("EMAILJS_SERVICE_ID");
const EMAILJS_PUBLIC_KEY = defineSecret("EMAILJS_PUBLIC_KEY");
const EMAILJS_PRIVATE_KEY = defineSecret("EMAILJS_PRIVATE_KEY");
const SECRETS = [EMAILJS_SERVICE_ID, EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY];

/* ════════════════════════════════════════════════════════════════
 * CONFIG — KENDİ ŞEMANA GÖRE DOĞRULA/DÜZENLE (tek seferlik)
 *  - templates: EmailJS panelinden aldığın Template ID'leri yapıştır.
 *  - alan adlarını gerçek Firestore dokümanlarınla eşle.
 * ════════════════════════════════════════════════════════════════ */
const CONFIG = {
  siteUrl: "https://pochub.co",

  // EmailJS Template ID'leri — DEĞİŞTİR:
  templates: {
    pocRequest: "TEMPLATE_POC_REQUEST", // yeni PoC talebi e-postası
    review:     "TEMPLATE_REVIEW",       // yeni değerlendirme e-postası
  },

  // poc_requests dokümanı alanları (bildirim VENDOR'a gider):
  pocRequest: {
    vendorIdField:    "vendorId",
    productNameField: "productName",   // yoksa "Ürününüz" yazılır
    customerNameField:"customerName",  // yoksa "Bir müşteri" yazılır
  },

  // reviews dokümanı alanları (bildirim VENDOR'a gider):
  review: {
    vendorIdField:    "vendorId",
    productNameField: "productName",   // yoksa productId kullanılır
    ratingField:      "rating",
  },
};

/* ── Yardımcı: bir uid için Auth e-postası (profil alanına bağımlı değil) ── */
async function emailForUid(uid) {
  if (!uid) return null;
  try {
    const u = await admin.auth().getUser(uid);
    return u.email || null;
  } catch (e) {
    console.error("emailForUid hata:", uid, e && e.message);
    return null;
  }
}

/* ── Yardımcı: EmailJS ile gönder (hata fırlatmaz → retry-loop/maliyet yok) ── */
async function sendMail(templateId, toEmail, params) {
  if (!templateId || templateId.indexOf("TEMPLATE_") === 0) {
    console.warn("Template ID ayarlanmamış, atlanıyor:", templateId);
    return;
  }
  if (!toEmail) {
    console.warn("Alıcı e-posta bulunamadı, atlanıyor.");
    return;
  }
  try {
    await emailjs.send(
      EMAILJS_SERVICE_ID.value(),
      templateId,
      Object.assign({ to_email: toEmail, site_url: CONFIG.siteUrl }, params || {}),
      { publicKey: EMAILJS_PUBLIC_KEY.value(), privateKey: EMAILJS_PRIVATE_KEY.value() }
    );
    console.log("E-posta gönderildi:", templateId, "→", toEmail);
  } catch (e) {
    console.error("EmailJS gönderim hatası:", (e && e.text) || (e && e.message) || e);
  }
}

/* ════════════════════════════════════════════════════════════════
 * 1) Yeni PoC talebi → VENDOR'a bildirim
 * ════════════════════════════════════════════════════════════════ */
exports.onPocRequestCreated = onDocumentCreated(
  { document: "poc_requests/{id}", secrets: SECRETS },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const d = snap.data() || {};
    const c = CONFIG.pocRequest;
    const vendorEmail = await emailForUid(d[c.vendorIdField]);
    await sendMail(CONFIG.templates.pocRequest, vendorEmail, {
      product_name:  d[c.productNameField]  || "Ürününüz",
      customer_name: d[c.customerNameField] || "Bir müşteri",
      link: CONFIG.siteUrl + "/#vendor",
    });
  }
);

/* ════════════════════════════════════════════════════════════════
 * 2) Yeni değerlendirme (review) → VENDOR'a bildirim
 * ════════════════════════════════════════════════════════════════ */
exports.onReviewCreated = onDocumentCreated(
  { document: "reviews/{id}", secrets: SECRETS },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const d = snap.data() || {};
    const c = CONFIG.review;
    const vendorEmail = await emailForUid(d[c.vendorIdField]);
    await sendMail(CONFIG.templates.review, vendorEmail, {
      product_name: d[c.productNameField] || d.productId || "Ürününüz",
      rating: String(d[c.ratingField] != null ? d[c.ratingField] : "-"),
      link: CONFIG.siteUrl + "/#vendor",
    });
  }
);

/* Yeni bildirim eklemek için: yukarıdaki kalıbı kopyala, document yolunu,
 * alıcıyı (emailForUid) ve template'i değiştir. SECRETS'i bağlamayı unutma. */
