/**
 * PoCHub Functions - Calendly Webhook Handler
 * v4.97 - Phase 4.4
 *
 * Calendly'den gelen webhook event'lerini dinler ve demo_requests
 * dokümanını günceller. Client-side postMessage (v4.90) ile birlikte
 * çalışır (hibrit yaklaşım — embed widget kapatılsa bile yakalanır).
 *
 * Calendly Webhook Setup:
 * 1. Calendly hesabında: Integrations → Webhooks → Create Webhook
 * 2. URL: https://europe-west1-pochub-co.cloudfunctions.net/calendlyWebhook
 * 3. Events: invitee.created, invitee.canceled
 * 4. Signing Key: kopyala, Firebase secret olarak set et:
 *    firebase functions:secrets:set CALENDLY_SIGNING_KEY
 *
 * Endpoint: POST /calendlyWebhook
 * Body: { event: "invitee.created", payload: {...} }
 * Headers: Calendly-Webhook-Signature
 */

import * as admin from "firebase-admin";
import * as crypto from "crypto";
import {onRequest} from "firebase-functions/v2/https";
import {defineSecret} from "firebase-functions/params";

const calendlySigningKey = defineSecret("CALENDLY_SIGNING_KEY");

/**
 * Calendly signature doğrulama
 * Format: "t=<timestamp>,v1=<hmac_sha256_signature>"
 */
function verifyCalendlySignature(
  signatureHeader: string,
  body: string,
  signingKey: string
): boolean {
  if (!signatureHeader) return false;

  try {
    const parts = signatureHeader.split(",");
    const tPart = parts.find((p) => p.startsWith("t="));
    const v1Part = parts.find((p) => p.startsWith("v1="));
    if (!tPart || !v1Part) return false;

    const timestamp = tPart.substring(2);
    const signature = v1Part.substring(3);

    // Replay attack koruması - 5 dakika
    const tsMs = parseInt(timestamp) * 1000;
    if (Math.abs(Date.now() - tsMs) > 5 * 60 * 1000) {
      console.warn("[calendlyWebhook] Stale timestamp:", timestamp);
      return false;
    }

    // HMAC-SHA256 doğrula
    const data = `${timestamp}.${body}`;
    const expected = crypto.createHmac("sha256", signingKey)
      .update(data)
      .digest("hex");

    return crypto.timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(expected, "hex")
    );
  } catch (e) {
    console.error("[calendlyWebhook] Signature verify error:", e);
    return false;
  }
}

export const calendlyWebhook = onRequest(
  {
    region: "europe-west1",
    memory: "256MiB",
    timeoutSeconds: 60,
    secrets: [calendlySigningKey],
    cors: false,
  },
  async (req, res) => {
    // Sadece POST
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    const db = admin.firestore();
    const rawBody = req.rawBody?.toString("utf8") || JSON.stringify(req.body);

    // Signature doğrulama
    const signatureHeader = req.get("Calendly-Webhook-Signature") || "";
    const signingKey = calendlySigningKey.value();

    if (!verifyCalendlySignature(signatureHeader, rawBody, signingKey)) {
      console.warn("[calendlyWebhook] Invalid signature, rejecting request");
      // Audit kayıt
      await db.collection("webhook_failures").add({
        source: "calendly",
        reason: "invalid_signature",
        ip: req.ip || null,
        userAgent: req.get("User-Agent") || null,
        receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      res.status(401).send("Invalid signature");
      return;
    }

    try {
      const event = req.body?.event;
      const payload = req.body?.payload || {};

      console.log("[calendlyWebhook] Event:", event);

      if (event === "invitee.created") {
        // Yeni randevu alındı
        const inviteeEmail = payload.email || payload.invitee?.email || null;
        const inviteeName = payload.name || payload.invitee?.name || null;
        const eventUri = payload.event?.uri || payload.scheduled_event?.uri || null;
        const inviteeUri = payload.uri || payload.invitee?.uri || null;
        const startTime = payload.scheduled_event?.start_time || null;

        // demo_requests dokümanı bul (email match) veya yeni oluştur
        let demoDocRef = null;
        if (inviteeEmail) {
          // Email'e göre son 24 saatlik kayıt ara
          const recentSnap = await db.collection("demo_requests")
            .where("userEmail", "==", inviteeEmail)
            .where("timestamp", ">=", admin.firestore.Timestamp.fromMillis(Date.now() - 86400 * 1000))
            .orderBy("timestamp", "desc")
            .limit(1)
            .get();

          if (!recentSnap.empty) {
            demoDocRef = recentSnap.docs[0].ref;
          }
        }

        if (demoDocRef) {
          // Mevcut kaydı güncelle
          await demoDocRef.update({
            status: "booked",
            bookedAt: admin.firestore.FieldValue.serverTimestamp(),
            calendlyEventUri: eventUri,
            calendlyInviteeUri: inviteeUri,
            scheduledStartTime: startTime,
            inviteeName: inviteeName,
            webhookSource: "calendly_webhook",
          });
          console.log("[calendlyWebhook] Updated existing demo_request:", demoDocRef.id);
        } else {
          // Yeni kayıt oluştur (kullanıcı sayfayı kapatmış olabilir)
          const newDocRef = await db.collection("demo_requests").add({
            source: "calendly_webhook",
            status: "booked",
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            bookedAt: admin.firestore.FieldValue.serverTimestamp(),
            userEmail: inviteeEmail,
            inviteeName: inviteeName,
            calendlyEventUri: eventUri,
            calendlyInviteeUri: inviteeUri,
            scheduledStartTime: startTime,
            webhookSource: "calendly_webhook",
          });
          console.log("[calendlyWebhook] Created new demo_request:", newDocRef.id);
        }

        // Admin'lere bildirim gönder
        const adminsSnap = await db.collection("users")
          .where("role", "==", "admin")
          .limit(5)
          .get();

        for (const adminDoc of adminsSnap.docs) {
          await db.collection("notifications").add({
            recipientId: adminDoc.id,
            userId: adminDoc.id, // backward compat
            type: "demo_booked",
            title: "📅 Yeni Demo Randevusu Alındı",
            message: `${inviteeName || inviteeEmail || "Birisi"} PoCHub demo sayfasından randevu aldı.${startTime ? " Tarih: " + new Date(startTime).toLocaleString("tr-TR") : ""}`,
            read: false,
            data: {
              calendlyEventUri: eventUri,
              inviteeEmail: inviteeEmail,
              startTime: startTime,
            },
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      } else if (event === "invitee.canceled") {
        // İptal edildi
        const inviteeUri = payload.uri || payload.invitee?.uri || null;
        if (inviteeUri) {
          const cancelSnap = await db.collection("demo_requests")
            .where("calendlyInviteeUri", "==", inviteeUri)
            .limit(1)
            .get();

          if (!cancelSnap.empty) {
            await cancelSnap.docs[0].ref.update({
              status: "canceled",
              canceledAt: admin.firestore.FieldValue.serverTimestamp(),
              cancellationReason: payload.cancellation?.reason || null,
            });
            console.log("[calendlyWebhook] Demo canceled:", cancelSnap.docs[0].id);
          }
        }
      } else {
        console.log("[calendlyWebhook] Unhandled event:", event);
      }

      res.status(200).json({ok: true});
    } catch (e: any) {
      console.error("[calendlyWebhook] Error:", e);
      // Audit kayıt
      await db.collection("webhook_failures").add({
        source: "calendly",
        reason: "processing_error",
        error: e.message?.slice(0, 1000) || String(e),
        body: rawBody.slice(0, 5000),
        receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      res.status(500).send("Internal error");
    }
  }
);
