import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CATALOGUE } from "../../../studio/src/lib/catalogue.js";
import { env } from "../config/env.js";
import { PLAN_IDS, type PlanId, type Region } from "../config/plans.js";
import { PaymentError, type PaymentGateway } from "../lib/cashfree.js";
import { invalidBody, sendError } from "../lib/http.js";
import { toAccount } from "../lib/mappers.js";
import {
  activatePayment,
  findPayment,
  insertPayment,
  listPayments,
  setPaymentStatus,
  type PaymentRecord,
} from "../lib/store.js";
import { requireAccount } from "../plugins/auth.js";

/**
 * Paying for a plan.
 *
 *   GET  /api/billing                  provider, paid-through date, payments
 *   POST /api/billing/checkout         price a plan and open a Cashfree order
 *   POST /api/billing/confirm          ask Cashfree whether it was paid
 *   POST /api/billing/webhook/cashfree Cashfree telling us, signed
 *
 * Every price comes from the catalogue, and the tax from its region, so
 * the amount charged is the amount the pricing page shows plus the tax it
 * names. The browser never sends an amount.
 */

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface Quote {
  readonly planId: PlanId;
  readonly region: Region;
  readonly subtotal: number;
  readonly tax: number;
  readonly taxName: string | null;
  readonly amount: number;
  readonly currency: string;
}

export function quote(planId: PlanId, region: Region): Quote {
  const plan = CATALOGUE.plans.find((p) => p.id === planId)!;
  const info = CATALOGUE.regions.find((r) => r.id === region)!;
  const subtotal = plan.price[region];
  const tax = info.taxRate ? round2(subtotal * info.taxRate) : 0;
  return {
    planId,
    region,
    subtotal,
    tax,
    taxName: info.taxName,
    amount: round2(subtotal + tax),
    currency: info.currencyCode,
  };
}

/**
 * The phone number Cashfree requires, as the ten digits it accepts.
 *
 * Indian numbers arrive as +91 98765 43210, 098765 43210 or 9876543210;
 * all three are the same ten digits. Anything else is refused here with a
 * message, rather than by Cashfree with a less useful one.
 */
export function normalisePhone(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  const ten = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits.length === 11 && digits.startsWith("0") ? digits.slice(1) : digits;
  return /^\d{10}$/.test(ten) ? ten : null;
}

const checkoutSchema = z.object({
  planId: z.enum(PLAN_IDS, { errorMap: () => ({ message: "Choose one of the plans." }) }),
  phone: z.string().trim().min(1, "A phone number is needed for the payment.").max(20),
});

const confirmSchema = z.object({ paymentId: z.string().min(3).max(45) });

const toPayment = (p: PaymentRecord) => ({
  id: p.id,
  planId: p.planId,
  amount: p.amount,
  subtotal: p.subtotal,
  tax: p.tax,
  currency: p.currency,
  status: p.status,
  mode: p.mode,
  createdAt: p.createdAt,
  paidAt: p.paidAt,
  periodStart: p.periodStart,
  periodEnd: p.periodEnd,
});

export async function billingRoutes(app: FastifyInstance, options: { gateway: PaymentGateway | null }) {
  const gateway = options.gateway;

  app.get("/api/billing", async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    const payments = await listPayments(account.id);
    return {
      provider: gateway ? { name: gateway.name, mode: gateway.mode, currencies: gateway.currencies } : null,
      paidThrough: account.paidThrough ?? null,
      payments: payments.slice(0, 24).map(toPayment),
    };
  });

  app.post("/api/billing/checkout", async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    if (!gateway) {
      return sendError(reply, 409, "Payments are not set up on this server. Choose the plan directly.");
    }
    const parsed = checkoutSchema.safeParse(request.body);
    if (!parsed.success) return invalidBody(reply, parsed.error);

    const phone = normalisePhone(parsed.data.phone);
    if (!phone) return sendError(reply, 400, "Enter a 10-digit mobile number.", "phone");

    const q = quote(parsed.data.planId, account.region);
    if (!gateway.currencies.includes(q.currency)) {
      return sendError(
        reply,
        409,
        `Payments in ${q.currency} are not available yet. Contact support to pay for your region.`,
      );
    }

    // Letters, digits and underscores, under Cashfree's 45-character limit.
    const id = "pay_" + Date.now().toString(36) + "_" + randomBytes(6).toString("hex");
    const record: PaymentRecord = {
      id,
      accountId: account.id,
      planId: q.planId,
      region: q.region,
      amount: q.amount,
      subtotal: q.subtotal,
      tax: q.tax,
      currency: q.currency,
      provider: "cashfree",
      mode: gateway.mode,
      providerOrderId: null,
      status: "created",
      createdAt: new Date().toISOString(),
      paidAt: null,
      periodStart: null,
      periodEnd: null,
    };

    const plan = CATALOGUE.plans.find((p) => p.id === q.planId)!;
    let created;
    try {
      created = await gateway.createOrder({
        orderId: id,
        amount: q.amount,
        currency: q.currency,
        customerId: account.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 50),
        customerPhone: phone,
        customerEmail: account.email,
        customerName: account.name.length >= 3 ? account.name : account.name.padEnd(3, "."),
        note: `Studio ${plan.name} plan, one month`,
        returnUrl: `${env.PUBLIC_WEB_URL}/app/billing?payment=${id}`,
        notifyUrl: env.PUBLIC_API_URL?.startsWith("https://")
          ? `${env.PUBLIC_API_URL}/api/billing/webhook/cashfree`
          : null,
      });
    } catch (error) {
      if (error instanceof PaymentError) return sendError(reply, error.status, error.message);
      throw error;
    }
    record.providerOrderId = created.providerOrderId || null;
    await insertPayment(record);

    return {
      payment: toPayment(record),
      paymentSessionId: created.paymentSessionId,
      mode: gateway.mode,
      quote: q,
    };
  });

  /**
   * Called by the browser when checkout closes. Proves nothing by itself:
   * the answer is Cashfree's, fetched here.
   */
  app.post("/api/billing/confirm", async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    if (!gateway) return sendError(reply, 409, "Payments are not set up on this server.");
    const parsed = confirmSchema.safeParse(request.body);
    if (!parsed.success) return invalidBody(reply, parsed.error);

    const payment = await findPayment(parsed.data.paymentId);
    // Someone else's payment id is answered exactly like a missing one.
    if (!payment || payment.accountId !== account.id) return sendError(reply, 404, "That payment was not found.");

    if (payment.status !== "paid") {
      let status;
      try {
        status = await gateway.orderStatus(payment.id);
      } catch (error) {
        if (error instanceof PaymentError) return sendError(reply, error.status, error.message);
        throw error;
      }
      if (status === "PAID") {
        const done = await activatePayment(payment.id);
        if (done) return { payment: toPayment(done.payment), account: toAccount(done.account) };
      } else if (status === "EXPIRED" || status === "TERMINATED") {
        await setPaymentStatus(payment.id, "expired");
      }
    }
    const latest = (await findPayment(payment.id))!;
    return { payment: toPayment(latest), account: toAccount(account) };
  });

  /**
   * Cashfree's webhook. Registered in its own scope so that this route --
   * and only this route -- receives the body as the exact string Cashfree
   * signed: re-serialising parsed JSON would change the bytes and every
   * signature would fail.
   */
  app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
      done(null, body);
    });

    scope.post("/api/billing/webhook/cashfree", async (request, reply) => {
      if (!gateway) return sendError(reply, 404, "Not found.");
      const raw = typeof request.body === "string" ? request.body : "";
      const timestamp = String(request.headers["x-webhook-timestamp"] ?? "");
      const signature = String(request.headers["x-webhook-signature"] ?? "");
      if (!gateway.verifyWebhook(raw, timestamp, signature)) {
        request.log.warn("cashfree webhook with a bad signature");
        return sendError(reply, 401, "Bad signature.");
      }

      let event: { type?: string; data?: { order?: { order_id?: string }; payment?: { payment_status?: string } } };
      try {
        event = JSON.parse(raw);
      } catch {
        return sendError(reply, 400, "Not JSON.");
      }
      const orderId = event.data?.order?.order_id;
      const status = event.data?.payment?.payment_status;
      if (!orderId) return { ok: true };

      const payment = await findPayment(orderId);
      // Not ours, or already handled: acknowledged either way, or Cashfree
      // retries a webhook we will never be able to act on.
      if (!payment || payment.status === "paid") return { ok: true };

      if (event.type === "PAYMENT_SUCCESS_WEBHOOK" && status === "SUCCESS") {
        await activatePayment(payment.id);
      } else if (status === "FAILED" || status === "USER_DROPPED" || status === "CANCELLED") {
        await setPaymentStatus(payment.id, "failed");
      }
      return { ok: true };
    });
  });
}
