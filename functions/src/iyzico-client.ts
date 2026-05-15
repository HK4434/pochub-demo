/**
 * PoCHub Functions - iyzico API Client
 * v4.76 - Phase 2.6
 *
 * Bu wrapper iyzico API V2'yi direkt fetch ile çağırır.
 * iyzipay-node paketi yerine native — daha az dependency, daha temiz.
 *
 * Authentication: HMAC-SHA256 ile signature oluştururuz.
 * Reference: https://docs.iyzico.com/api/authentication
 */

import * as crypto from "crypto";

// ─────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────

export interface IyzicoConfig {
  apiKey: string;
  secretKey: string;
  baseUrl: string; // sandbox veya production
}

export interface CheckoutInitRequest {
  conversationId: string;     // bizim tarafımızdaki unique transaction ID
  price: string;              // ödenecek toplam, "100.00" format
  paidPrice: string;          // KDV dahil ödenen, "100.00"
  currency: "TRY";
  basketId: string;           // bizim package ID
  paymentGroup: "PRODUCT" | "SUBSCRIPTION";
  callbackUrl: string;        // iyzico bizim callback Function URL'i
  enabledInstallments?: number[]; // taksit seçenekleri
  buyer: {
    id: string;
    name: string;
    surname: string;
    gsmNumber: string;        // +90...
    email: string;
    identityNumber: string;   // TC/VKN
    registrationAddress: string;
    ip: string;
    city: string;
    country: string;
    zipCode?: string;
  };
  shippingAddress: {
    contactName: string;
    city: string;
    country: string;
    address: string;
    zipCode?: string;
  };
  billingAddress: {
    contactName: string;
    city: string;
    country: string;
    address: string;
    zipCode?: string;
  };
  basketItems: Array<{
    id: string;
    name: string;
    category1: string;
    itemType: "VIRTUAL" | "PHYSICAL";
    price: string;
  }>;
}

export interface CheckoutInitResponse {
  status: "success" | "failure";
  errorCode?: string;
  errorMessage?: string;
  errorGroup?: string;
  locale: string;
  systemTime: number;
  conversationId: string;
  token?: string;
  checkoutFormContent?: string; // iframe içine konacak HTML+JS
  paymentPageUrl?: string;
  tokenExpireTime?: number;
}

export interface CheckoutRetrieveResponse {
  status: "success" | "failure";
  errorCode?: string;
  errorMessage?: string;
  paymentStatus?: "SUCCESS" | "FAILURE" | "INIT_THREEDS" | "CALLBACK_THREEDS";
  paymentId?: string;
  paymentItems?: Array<{
    itemId: string;
    paymentTransactionId: string;
    transactionStatus: number;
    price: string;
    paidPrice: string;
  }>;
  installment?: number;
  conversationId: string;
  token: string;
  basketId?: string;
  binNumber?: string;
  lastFourDigits?: string;
  cardAssociation?: string; // VISA, MASTER_CARD, AMEX
  cardFamily?: string;
  cardType?: string;
  fraudStatus?: number;
  // ...diğer alanlar
}

// ─────────────────────────────────────────────────────────────────────
// AUTH SIGNATURE
// ─────────────────────────────────────────────────────────────────────

/**
 * iyzico API V2 — HMAC-SHA256 imza oluşturur.
 * Format: Authorization: IYZWSv2 <base64(authStr)>
 *
 * Reference: https://docs.iyzico.com/api/authentication
 */
function generateAuthHeader(
  config: IyzicoConfig,
  uri: string,
  randomKey: string,
  body: any
): string {
  const payload = randomKey + uri + JSON.stringify(body);
  const signature = crypto
    .createHmac("sha256", config.secretKey)
    .update(payload)
    .digest("hex");

  const authStr = `apiKey:${config.apiKey}&randomKey:${randomKey}&signature:${signature}`;
  const base64Auth = Buffer.from(authStr).toString("base64");

  return `IYZWSv2 ${base64Auth}`;
}

// ─────────────────────────────────────────────────────────────────────
// API CALLS
// ─────────────────────────────────────────────────────────────────────

/**
 * Checkout Form Initialize — kullanıcı ödeme sayfasına yönlendirilir.
 */
export async function checkoutInitialize(
  config: IyzicoConfig,
  request: CheckoutInitRequest
): Promise<CheckoutInitResponse> {
  const uri = "/payment/iyzipos/checkoutform/initialize/auth/ecom";
  const randomKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const fullBody = {
    locale: "tr",
    conversationId: request.conversationId,
    price: request.price,
    paidPrice: request.paidPrice,
    currency: request.currency,
    basketId: request.basketId,
    paymentGroup: request.paymentGroup,
    callbackUrl: request.callbackUrl,
    enabledInstallments: request.enabledInstallments || [1, 2, 3, 6, 9, 12],
    buyer: request.buyer,
    shippingAddress: request.shippingAddress,
    billingAddress: request.billingAddress,
    basketItems: request.basketItems,
  };

  const authHeader = generateAuthHeader(config, uri, randomKey, fullBody);

  const response = await fetch(`${config.baseUrl}${uri}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-iyzi-rnd": randomKey,
      "Authorization": authHeader,
    },
    body: JSON.stringify(fullBody),
  });

  const data = (await response.json()) as CheckoutInitResponse;
  return data;
}

/**
 * Checkout Form Retrieve — ödeme tamamlandıktan sonra detayları çeker.
 * Bu callback Function tarafında çağrılır.
 */
export async function checkoutRetrieve(
  config: IyzicoConfig,
  token: string
): Promise<CheckoutRetrieveResponse> {
  const uri = "/payment/iyzipos/checkoutform/auth/ecom/detail";
  const randomKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const body = {
    locale: "tr",
    token: token,
  };

  const authHeader = generateAuthHeader(config, uri, randomKey, body);

  const response = await fetch(`${config.baseUrl}${uri}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-iyzi-rnd": randomKey,
      "Authorization": authHeader,
    },
    body: JSON.stringify(body),
  });

  const data = (await response.json()) as CheckoutRetrieveResponse;
  return data;
}

// ─────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────

/**
 * Para tutarı formatla — iyzico "100.00" gibi string ister.
 */
export function formatPrice(amount: number): string {
  return amount.toFixed(2);
}

/**
 * KDV hesabı (Türkiye'de %20 default).
 * Brüt fiyattan netleştirir.
 */
export function calculateVat(grossAmount: number, vatRate: number = 20) {
  const netAmount = grossAmount / (1 + vatRate / 100);
  const vatAmount = grossAmount - netAmount;
  return {
    net: Math.round(netAmount * 100) / 100,
    vat: Math.round(vatAmount * 100) / 100,
    gross: grossAmount,
  };
}
