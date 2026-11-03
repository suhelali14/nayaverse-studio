import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";

/**
 * Taking payment, through Cashfree's Payment Gateway "Orders" API.
 *
 * ── Why orders, one period at a time ────────────────────────────────
 *
 * Each payment buys one billing period of one plan: the account pays, the
 * plan runs to the end of the period, and the next period is another
 * payment. Cashfree's subscription mandates (UPI Autopay, eNACH) are the
 * next step, but they need the subscription product enabled on the
 * merchant account and a mandate-authorisation flow; a prepaid period
 * works with every method a Cashfree account accepts on day one, and it
 * is exactly what the catalogue promises -- "the plan runs to the end of
 * the period you have paid for".
 *
 * ── The one rule ────────────────────────────────────────────────────
 *
 * **A plan is only ever activated from Cashfree's own answer.** The browser
 * coming back from checkout proves nothing -- anyone can call the confirm
 * route -- so confirmation fetches the order from Cashfree and checks
 * `order_status === "PAID"`, and the webhook is accepted only with a valid
 * signature. Both paths end in the same idempotent activation.
 *
 * Request and response shapes are from Cashfree's PG reference
 * (api-reference/payments/latest/orders/create and /get) and its webhook
 * signature guide, read for this integration.
 */

export type OrderStatus = "ACTIVE" | "PAID" | "EXPIRED" | "TERMINATED" | "TERMINATION_REQUESTED";

export interface CreateOrderInput {
  /** Ours: letters, digits, `_` and `-`, 3 to 45 characters. */
  readonly orderId: string;
  readonly amount: number;
  readonly currency: string;
  /** Letters and digits only, 3 to 50 characters. */
  readonly customerId: string;
  readonly customerPhone: string;
  readonly customerEmail: string;
  readonly customerName: string;
  readonly note: string;
  readonly returnUrl: string;
  readonly notifyUrl: string | null;
}

export interface CreatedOrder {
  readonly providerOrderId: string;
  readonly paymentSessionId: string;
  readonly status: OrderStatus;
}

/** What the rest of the API needs of a payment provider. Tests pass a fake. */
export interface PaymentGateway {
  readonly name: "cashfree";
  readonly mode: "sandbox" | "production";
  readonly currencies: readonly string[];
  createOrder(input: CreateOrderInput): Promise<CreatedOrder>;
  orderStatus(orderId: string): Promise<OrderStatus>;
  /** True when a webhook's signature is Cashfree's, over these exact bytes. */
  verifyWebhook(rawBody: string, timestamp: string, signature: string): boolean;
}

export class PaymentError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Cashfree signs `timestamp + rawBody` with the merchant's secret key,
 * HMAC-SHA256, base64. Exported so the test can sign a payload the same
 * way Cashfree does.
 */
export function signWebhook(rawBody: string, timestamp: string, secret: string): string {
  return createHmac("sha256", secret).update(timestamp + rawBody).digest("base64");
}

export function verifySignature(rawBody: string, timestamp: string, signature: string, secret: string): boolean {
  if (!timestamp || !signature) return false;
  const expected = Buffer.from(signWebhook(rawBody, timestamp, secret));
  const given = Buffer.from(signature);
  // Constant time: a comparison that stops at the first wrong byte tells an
  // attacker how many bytes they have right.
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function cashfreeGateway(config: {
  appId: string;
  secret: string;
  mode: "sandbox" | "production";
  apiVersion: string;
  currencies: readonly string[];
}): PaymentGateway {
  const base = config.mode === "production" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg";
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    "x-api-version": config.apiVersion,
    "x-client-id": config.appId,
    "x-client-secret": config.secret,
  };

  /** Cashfree's own message, which is usually the useful part. */
  const fail = async (response: Response, what: string): Promise<never> => {
    let detail = "";
    try {
      const body = (await response.json()) as { message?: string };
      detail = body.message ?? "";
    } catch {
      /* not JSON */
    }
    // A 4xx from Cashfree is about what we sent; a 5xx is theirs. Neither
    // carries a key, so the message is safe to pass on.
    throw new PaymentError(
      `Cashfree could not ${what}${detail ? `: ${detail}` : "."}`,
      response.status >= 500 ? 502 : 400,
    );
  };

  return {
    name: "cashfree",
    mode: config.mode,
    currencies: config.currencies,

    async createOrder(input) {
      const response = await fetch(`${base}/orders`, {
        method: "POST",
        headers: { ...headers, "x-idempotency-key": input.orderId },
        body: JSON.stringify({
          order_id: input.orderId,
          order_amount: input.amount,
          order_currency: input.currency,
          order_note: input.note,
          customer_details: {
            customer_id: input.customerId,
            customer_phone: input.customerPhone,
            customer_email: input.customerEmail,
            customer_name: input.customerName,
          },
          order_meta: {
            return_url: input.returnUrl,
            ...(input.notifyUrl ? { notify_url: input.notifyUrl } : {}),
          },
        }),
      });
      if (!response.ok) await fail(response, "start the payment");
      const body = (await response.json()) as {
        cf_order_id?: string | number;
        payment_session_id?: string;
        order_status?: OrderStatus;
      };
      if (!body.payment_session_id) throw new PaymentError("Cashfree did not return a payment session.", 502);
      return {
        providerOrderId: String(body.cf_order_id ?? ""),
        paymentSessionId: body.payment_session_id,
        status: body.order_status ?? "ACTIVE",
      };
    },

    async orderStatus(orderId) {
      const response = await fetch(`${base}/orders/${encodeURIComponent(orderId)}`, { headers });
      if (!response.ok) await fail(response, "check the payment");
      const body = (await response.json()) as { order_status?: OrderStatus };
      return body.order_status ?? "ACTIVE";
    },

    verifyWebhook(rawBody, timestamp, signature) {
      return verifySignature(rawBody, timestamp, signature, config.secret);
    },
  };
}

/** The gateway this process is configured for, or null in test mode. */
export function resolveGateway(): PaymentGateway | null {
  if (!env.CASHFREE_APP_ID || !env.CASHFREE_SECRET_KEY) return null;
  return cashfreeGateway({
    appId: env.CASHFREE_APP_ID,
    secret: env.CASHFREE_SECRET_KEY,
    mode: env.CASHFREE_ENV,
    apiVersion: env.CASHFREE_API_VERSION,
    currencies: env.CASHFREE_CURRENCY_LIST,
  });
}
