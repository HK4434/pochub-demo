/**
 * PoCHub Functions - Shared Helpers
 * v4.75
 */

import * as admin from "firebase-admin";
import {HttpsError, CallableRequest} from "firebase-functions/v2/https";

// ─────────────────────────────────────────────────────────────────────
// AUTH HELPERS
// ─────────────────────────────────────────────────────────────────────

/**
 * Auth zorunlu — token yoksa unauthenticated atar.
 */
export function requireAuth(request: CallableRequest): string {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Auth required");
  }
  return request.auth.uid;
}

/**
 * Auth + admin rol kontrolü.
 */
export async function requireAdmin(request: CallableRequest): Promise<string> {
  const uid = requireAuth(request);
  const db = admin.firestore();
  const userDoc = await db.collection("users").doc(uid).get();
  if (!userDoc.exists) {
    throw new HttpsError("permission-denied", "User not found");
  }
  const data = userDoc.data();
  if (data?.role !== "admin") {
    throw new HttpsError("permission-denied", "Admin role required");
  }
  return uid;
}

/**
 * Auth + vendor rol kontrolü.
 */
export async function requireVendor(request: CallableRequest): Promise<string> {
  const uid = requireAuth(request);
  const db = admin.firestore();
  const userDoc = await db.collection("users").doc(uid).get();
  if (!userDoc.exists) {
    throw new HttpsError("permission-denied", "User not found");
  }
  const data = userDoc.data();
  if (data?.role !== "vendor") {
    throw new HttpsError("permission-denied", "Vendor role required");
  }
  return uid;
}

// ─────────────────────────────────────────────────────────────────────
// VALIDATION HELPERS
// ─────────────────────────────────────────────────────────────────────

/**
 * Required field kontrolü.
 */
export function requireFields(data: any, fields: string[]): void {
  if (!data || typeof data !== "object") {
    throw new HttpsError("invalid-argument", "Request data missing");
  }
  for (const field of fields) {
    if (data[field] === undefined || data[field] === null || data[field] === "") {
      throw new HttpsError(
        "invalid-argument",
        `Required field missing: ${field}`
      );
    }
  }
}

/**
 * Sayı doğrulama (NaN, negatif vs).
 */
export function requireNumber(
  value: any,
  name: string,
  opts: {min?: number; max?: number; integer?: boolean} = {}
): number {
  const n = Number(value);
  if (isNaN(n)) {
    throw new HttpsError("invalid-argument", `${name} must be a number`);
  }
  if (opts.integer && !Number.isInteger(n)) {
    throw new HttpsError("invalid-argument", `${name} must be an integer`);
  }
  if (opts.min !== undefined && n < opts.min) {
    throw new HttpsError("invalid-argument", `${name} must be >= ${opts.min}`);
  }
  if (opts.max !== undefined && n > opts.max) {
    throw new HttpsError("invalid-argument", `${name} must be <= ${opts.max}`);
  }
  return n;
}

// ─────────────────────────────────────────────────────────────────────
// LOGGING HELPERS (audit trail)
// ─────────────────────────────────────────────────────────────────────

/**
 * Critical action'ları audit_log koleksiyonuna yazar.
 */
export async function auditLog(
  uid: string,
  action: string,
  details: any
): Promise<void> {
  try {
    const db = admin.firestore();
    await db.collection("audit_log").add({
      uid,
      action,
      details,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      ip: "function", // CF doesn't expose IP easily
    });
  } catch (e) {
    console.error("Audit log error:", e);
    // Asla audit log hatası nedeniyle main flow fail etmesin
  }
}

// ─────────────────────────────────────────────────────────────────────
// RESPONSE HELPERS
// ─────────────────────────────────────────────────────────────────────

/**
 * Standart success response.
 */
export function ok<T>(data: T): {ok: true; data: T} {
  return {ok: true, data};
}

/**
 * Hata handler — production'da stack izleme kapalı, sandbox'ta açık.
 */
export function handleError(e: any, context: string): never {
  console.error(`[${context}] error:`, e);
  if (e instanceof HttpsError) {
    throw e;
  }
  throw new HttpsError("internal", e?.message || "Internal error");
}
