/**
 * PoCHub Functions - Hello/Test Functions
 * v4.75 starter functions
 */

import * as admin from "firebase-admin";
import {onCall} from "firebase-functions/v2/https";
import {requireAuth, ok, handleError} from "./helpers";

// ─────────────────────────────────────────────────────────────────────
// helloWorld - Public test endpoint
// ─────────────────────────────────────────────────────────────────────

/**
 * Auth gerektirmeyen ping endpoint.
 * Functions deploy'unun çalışıp çalışmadığını doğrulamak için.
 */
export const helloWorld = onCall(async (request) => {
  try {
    return ok({
      message: "Hello from PoCHub Functions!",
      version: "v4.75",
      region: "europe-west1",
      timestamp: Date.now(),
      receivedData: request.data || null,
      authenticated: !!request.auth,
    });
  } catch (e) {
    handleError(e, "helloWorld");
  }
});

// ─────────────────────────────────────────────────────────────────────
// getServerTime - Auth gerektiren basit endpoint
// ─────────────────────────────────────────────────────────────────────

/**
 * Server'ın saat dilimi ve zamanını döner. Client clock skew test için.
 */
export const getServerTime = onCall(async (request) => {
  try {
    requireAuth(request);
    const now = new Date();
    return ok({
      serverTime: now.toISOString(),
      serverTimestamp: now.getTime(),
      serverTimezone: process.env.TZ || "UTC",
      uid: request.auth?.uid,
    });
  } catch (e) {
    handleError(e, "getServerTime");
  }
});

// ─────────────────────────────────────────────────────────────────────
// getCurrentUser - Auth + Firestore'dan kullanıcı bilgisi
// ─────────────────────────────────────────────────────────────────────

/**
 * Giriş yapan kullanıcının Firestore'daki tüm bilgilerini server-side okur.
 * Test: rol, subscription tier vs.
 */
export const getCurrentUser = onCall(async (request) => {
  try {
    const uid = requireAuth(request);
    const db = admin.firestore();

    const [userDoc, subDoc, billDoc] = await Promise.all([
      db.collection("users").doc(uid).get(),
      db.collection("vendor_subscriptions").doc(uid).get(),
      db.collection("vendor_billing").doc(uid).get(),
    ]);

    if (!userDoc.exists) {
      return ok({uid, exists: false});
    }

    const user = userDoc.data();
    return ok({
      uid,
      exists: true,
      email: request.auth?.token?.email || user?.email,
      role: user?.role,
      displayName: user?.displayName,
      company: user?.company,
      subscriptionTier: user?.subscriptionTier || "free",
      hasActiveSubscription: user?.hasActiveSubscription || false,
      isSuspended: user?.isSuspendedDueToBilling || false,
      subscription: subDoc.exists ? {
        currentTier: subDoc.data()?.currentTier,
        status: subDoc.data()?.status,
        endDate: subDoc.data()?.endDate?.toDate?.()?.toISOString() || null,
      } : null,
      billing: billDoc.exists ? {
        unpaidBalance: billDoc.data()?.unpaidBalance || 0,
        unpaidPocCount: billDoc.data()?.unpaidPocCount || 0,
        isSuspended: billDoc.data()?.isSuspended || false,
      } : null,
    });
  } catch (e) {
    handleError(e, "getCurrentUser");
  }
});
