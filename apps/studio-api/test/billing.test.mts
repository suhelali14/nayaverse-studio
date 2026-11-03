/**
 * Payments, end to end through the real routes, against a fake gateway.
 *
 * The fake records what it was asked and answers whatever status a test
 * sets, so every path -- paid, unpaid, expired, duplicate confirmation,
 * forged webhook -- is exercised without a network or a Cashfree account.
 * The signature check is the real one: the fake signs with the same
 * function Cashfree's algorithm is implemented in.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA_DIR = mkdtempSync(join(tmpdir(), "studio-billing-test-"));
process.env.NODE_ENV = "test";
process.env.STUDIO_DATA_DIR = DATA_DIR;
process.env.STUDIO_UPLOAD_DIR = join(DATA_DIR, "uploads");
delete process.env.JWT_SECRET;
delete process.env.CASHFREE_APP_ID;
delete process.env.CASHFREE_SECRET_KEY;

const { buildApp } = await import("../src/app.js");
const { quote, normalisePhone } = await import("../src/routes/billing.js");
const { signWebhook, verifySignature } = await import("../src/lib/cashfree.js");
const { activatePayment, addMonth, flushWrites } = await import("../src/lib/store.js");
type PaymentGateway = import("../src/lib/cashfree.js").PaymentGateway;
type CreateOrderInput = import("../src/lib/cashfree.js").CreateOrderInput;
type OrderStatus = import("../src/lib/cashfree.js").OrderStatus;

let pass = 0;
let fail = 0;
const ok = (cond: boolean, what: string, extra = ""): void => {
  if (cond) {
    pass += 1;
    console.log(`  ok    ${what}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${what}${extra ? `\n          ${extra}` : ""}`);
  }
};
const eq = <T,>(actual: T, expected: T, what: string): void =>
  ok(actual === expected, what, `expected ${String(expected)}, got ${String(actual)}`);

// ── Pure parts ──────────────────────────────────────────────────────────

console.log("\nquote");
{
  const india = quote("creator", "IN");
  eq(india.subtotal, 999, "the Creator plan's Indian price is the catalogue's");
  eq(india.tax, 179.82, "with 18% GST on top");
  eq(india.amount, 1178.82, "and the charge is the two together");
  eq(india.currency, "INR", "in rupees");
  const world = quote("creator", "WORLD");
  eq(world.tax, 0, "no tax line outside India");
  eq(world.amount, 29, "so the charge is the list price");
  eq(world.currency, "USD", "in dollars");
}

console.log("\nphone numbers");
eq(normalisePhone("+91 98765 43210"), "9876543210", "+91 with spaces becomes ten digits");
eq(normalisePhone("098765-43210"), "9876543210", "a leading 0 is dropped");
eq(normalisePhone("9876543210"), "9876543210", "ten digits stay ten digits");
eq(normalisePhone("12345"), null, "too short is refused");
eq(normalisePhone("+44 20 7946 0958 12"), null, "a number that is not ten digits is refused");

console.log("\nwebhook signatures");
{
  const body = '{"type":"PAYMENT_SUCCESS_WEBHOOK"}';
  const sig = signWebhook(body, "1617695238078", "secret-key");
  ok(verifySignature(body, "1617695238078", sig, "secret-key"), "a signature over timestamp + body verifies");
  ok(!verifySignature(body + " ", "1617695238078", sig, "secret-key"), "one changed byte in the body fails");
  ok(!verifySignature(body, "1617695238079", sig, "secret-key"), "a different timestamp fails");
  ok(!verifySignature(body, "1617695238078", sig, "other-key"), "the wrong secret fails");
  ok(!verifySignature(body, "1617695238078", "", "secret-key"), "an empty signature fails");
  ok(!verifySignature(body, "1617695238078", "short", "secret-key"), "a signature of the wrong length fails without throwing");
}

eq(addMonth("2026-01-31T10:00:00.000Z"), "2026-02-28T10:00:00.000Z", "a month after 31 January is the last day of February");
eq(addMonth("2026-11-03T00:00:00.000Z"), "2026-12-03T00:00:00.000Z", "and an ordinary month is the same day next month");

// ── Through the routes ──────────────────────────────────────────────────

const SECRET = "fake-cashfree-secret";
const created: CreateOrderInput[] = [];
const statuses = new Map<string, OrderStatus>();
const fake: PaymentGateway = {
  name: "cashfree",
  mode: "sandbox",
  currencies: ["INR"],
  async createOrder(input) {
    created.push(input);
    statuses.set(input.orderId, "ACTIVE");
    return { providerOrderId: "cf_" + created.length, paymentSessionId: "session_" + input.orderId, status: "ACTIVE" };
  },
  async orderStatus(orderId) {
    return statuses.get(orderId) ?? "ACTIVE";
  },
  verifyWebhook: (raw, ts, sig) => verifySignature(raw, ts, sig, SECRET),
};

const app = buildApp({ worker: false, paymentGateway: fake, authRateLimitMax: 1000 });
type App = typeof app;

async function call(method: "GET" | "POST", url: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({
    method,
    url,
    remoteAddress: "10.4.0.1",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body === undefined ? {} : typeof body === "string" ? { payload: body } : { payload: body as object }),
  });
  return { status: res.statusCode, json: <T,>() => JSON.parse(res.body) as T };
}

let seq = 0;
async function signUp(region: "IN" | "WORLD" = "IN"): Promise<string> {
  seq += 1;
  const res = await call("POST", "/api/auth/signup", undefined, {
    email: `payer${seq}@example.com`,
    password: "a long enough passphrase",
    name: `Payer ${seq}`,
    region,
  });
  return res.json<{ token: string }>().token;
}

function webhook(orderId: string, status: string, type = "PAYMENT_SUCCESS_WEBHOOK", secret = SECRET) {
  const raw = JSON.stringify({ type, data: { order: { order_id: orderId }, payment: { payment_status: status } } });
  const ts = String(Date.now());
  return call("POST", "/api/billing/webhook/cashfree", undefined, raw, {
    "content-type": "application/json",
    "x-webhook-timestamp": ts,
    "x-webhook-signature": signWebhook(raw, ts, secret),
  });
}

type Payment = { id: string; status: string; amount: number; periodEnd: string | null };
type Account = { planId: string | null; paidThrough: string | null };

console.log("\nwith a gateway, a plan is bought, not chosen");
const token = await signUp();
{
  const direct = await call("POST", "/api/account/plan", token, { planId: "studio" });
  eq(direct.status, 402, "the direct plan route refuses");

  const before = await call("POST", "/api/projects", token, { title: "Before paying", language: "en" });
  eq(before.status, 403, "nothing can be created before a plan is paid for");

  const noPhone = await call("POST", "/api/billing/checkout", token, { planId: "creator" });
  eq(noPhone.status, 400, "checkout needs a phone number");
  const badPhone = await call("POST", "/api/billing/checkout", token, { planId: "creator", phone: "12345" });
  eq(badPhone.status, 400, "and refuses one that is not ten digits");
}

const checkout = await call("POST", "/api/billing/checkout", token, { planId: "creator", phone: "+91 98765 43210", amount: 1 });
eq(checkout.status, 200, "checkout opens an order");
const first = checkout.json<{ payment: Payment; paymentSessionId: string }>();
{
  const sent = created[created.length - 1]!;
  eq(sent.amount, 1178.82, "the gateway is asked for the catalogue price plus GST, not the amount the browser sent");
  eq(sent.currency, "INR", "in rupees");
  eq(sent.customerPhone, "9876543210", "with the phone as ten digits");
  ok(/^[A-Za-z0-9]{3,50}$/.test(sent.customerId), "with a customer id Cashfree accepts", sent.customerId);
  ok(/^[A-Za-z0-9_-]{3,45}$/.test(sent.orderId), "and an order id it accepts", sent.orderId);
  ok(sent.returnUrl.includes(first.payment.id), "returning to a page that names the payment");
  eq(first.paymentSessionId, "session_" + first.payment.id, "the session id is handed to the browser");
  eq(first.payment.status, "created", "the payment starts unpaid");
}

console.log("\nconfirmation asks the gateway");
{
  const unpaid = await call("POST", "/api/billing/confirm", token, { paymentId: first.payment.id });
  eq(unpaid.json<{ payment: Payment }>().payment.status, "created", "an order still ACTIVE is not paid");
  eq(unpaid.json<{ account: Account }>().account.planId, null, "and buys nothing");

  statuses.set(first.payment.id, "PAID");
  const paid = await call("POST", "/api/billing/confirm", token, { paymentId: first.payment.id });
  const body = paid.json<{ payment: Payment; account: Account }>();
  eq(body.payment.status, "paid", "once Cashfree says PAID, the payment is paid");
  eq(body.account.planId, "creator", "and the account is on the plan it bought");
  const through = body.account.paidThrough!;
  const days = (Date.parse(through) - Date.now()) / 86_400_000;
  ok(days > 27 && days < 32, "for one month", through);

  const again = await call("POST", "/api/billing/confirm", token, { paymentId: first.payment.id });
  eq(again.json<{ account: Account }>().account.paidThrough, through, "confirming twice does not buy a second month");
  const hook = await webhook(first.payment.id, "SUCCESS");
  eq(hook.status, 200, "the webhook for the same payment is acknowledged");
  const state = await call("GET", "/api/billing", token);
  eq(state.json<{ paidThrough: string }>().paidThrough, through, "and does not extend it either");

  const made = await call("POST", "/api/projects", token, { title: "After paying", language: "en" });
  ok(made.status === 200 || made.status === 201, "after paying, projects can be created", String(made.status));

  // Paying early extends from the end of the current period.
  const second = (await call("POST", "/api/billing/checkout", token, { planId: "studio", phone: "9876543210" })).json<{ payment: Payment }>();
  await webhook(second.payment.id, "SUCCESS");
  const after = (await call("GET", "/api/billing", token)).json<{ paidThrough: string; payments: Payment[] }>();
  eq(after.paidThrough, addMonth(through), "a second payment adds a month to the end of the first");
  eq(after.payments.length, 2, "both payments are listed");
  eq(after.payments.filter((p) => p.status === "paid").length, 2, "both as paid");
}

console.log("\nwebhooks are believed only when signed");
{
  const t = await signUp();
  const p = (await call("POST", "/api/billing/checkout", t, { planId: "starter", phone: "9876543210" })).json<{ payment: Payment }>();
  const forged = await webhook(p.payment.id, "SUCCESS", "PAYMENT_SUCCESS_WEBHOOK", "not-the-secret");
  eq(forged.status, 401, "a webhook signed with another key is refused");
  const me = (await call("GET", "/api/auth/me", t)).json<Account>();
  eq(me.planId, null, "and buys nothing");

  const dropped = await webhook(p.payment.id, "USER_DROPPED", "PAYMENT_FAILED_WEBHOOK");
  eq(dropped.status, 200, "a failed-payment webhook is acknowledged");
  const listed = (await call("GET", "/api/billing", t)).json<{ payments: Payment[] }>();
  eq(listed.payments[0]!.status, "failed", "and marks the payment failed");

  const stranger = await signUp();
  const peek = await call("POST", "/api/billing/confirm", stranger, { paymentId: p.payment.id });
  eq(peek.status, 404, "another account's payment cannot be confirmed or even seen");
}

console.log("\nregions and lapsed plans");
{
  const abroad = await signUp("WORLD");
  const usd = await call("POST", "/api/billing/checkout", abroad, { planId: "creator", phone: "9876543210" });
  eq(usd.status, 409, "a currency the Cashfree account cannot take is refused up front");

  const lapsed = await signUp();
  const p = (await call("POST", "/api/billing/checkout", lapsed, { planId: "creator", phone: "9876543210" })).json<{ payment: Payment }>();
  await activatePayment(p.payment.id, new Date("2020-01-01T00:00:00.000Z"));
  const locked = await call("POST", "/api/projects", lapsed, { title: "Too late", language: "en" });
  eq(locked.status, 402, "once the paid period has ended, creating is refused");
  ok(/ended on 2020-02-01/.test(locked.json<{ error: string }>().error), "with the date it ended", locked.json<{ error: string }>().error);
}

await app.close();

console.log("\nwithout a gateway (test mode)");
{
  const plain = buildApp({ worker: false, paymentGateway: null, authRateLimitMax: 1000 });
  const s = await plain.inject({
    method: "POST",
    url: "/api/auth/signup",
    remoteAddress: "10.4.1.1",
    payload: { email: "free@example.com", password: "a long enough passphrase", name: "Free", region: "IN" },
  });
  const t = (JSON.parse(s.body) as { token: string }).token;
  const auth = { authorization: `Bearer ${t}` };
  const co = await plain.inject({ method: "POST", url: "/api/billing/checkout", headers: auth, payload: { planId: "creator", phone: "9876543210" } });
  eq(co.statusCode, 409, "checkout says payments are not set up");
  const direct = await plain.inject({ method: "POST", url: "/api/account/plan", headers: auth, payload: { planId: "creator" } });
  eq(direct.statusCode, 200, "and the plan can be chosen directly");
  const made = await plain.inject({ method: "POST", url: "/api/projects", headers: auth, payload: { title: "Free", language: "en" } });
  ok(made.statusCode === 200 || made.statusCode === 201, "and used without paying", String(made.statusCode));
  await plain.close();
}

await flushWrites();
rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
