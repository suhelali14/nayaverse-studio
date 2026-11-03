import { DUB_OVERAGE_PER_MINUTE, PLANS, plansIncludingDubbing } from "../config/plans.js";
import type { PlanLimits } from "../config/plans.js";
import type { Usage } from "./mappers.js";
import { listUsage, type AccountRecord } from "./store.js";

/**
 * Billing periods and what a plan allows inside one.
 *
 * The numbers come from `config/plans.ts` and nowhere else; this module
 * does the arithmetic and writes the refusal messages.
 */

/**
 * The period containing `now`, anchored to the account's own signup day.
 *
 * Not the calendar month: an account created on the 28th would otherwise
 * get three days of its first month's reels. Not the plan-chosen date
 * either, even though that is closer to when money starts -- anchoring on
 * it would move everyone's renewal day each time they changed plan, and a
 * cap that resets when you switch plans is a cap you can reset at will.
 *
 * Signup day it is, which is stable for the life of the account.
 */
export function billingPeriod(
  account: AccountRecord,
  now: Date = new Date(),
): { start: string; end: string } {
  const created = new Date(account.createdAt);
  const anchorDay = created.getUTCDate();

  // Walk back from this month to find the period start at or before `now`.
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();

  const startFor = (y: number, m: number): Date => {
    // Someone who signed up on the 31st has no 31st in February. Clamping
    // to the last day of the short month keeps the period contiguous; the
    // alternative, rolling into March, leaves a gap in which usage belongs
    // to no period at all.
    const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const day = Math.min(anchorDay, daysInMonth);
    return new Date(
      Date.UTC(
        y,
        m,
        day,
        created.getUTCHours(),
        created.getUTCMinutes(),
        created.getUTCSeconds(),
        created.getUTCMilliseconds(),
      ),
    );
  };

  let start = startFor(year, month);
  if (start.getTime() > now.getTime()) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
    start = startFor(year, month);
  }

  let nextMonth = month + 1;
  let nextYear = year;
  if (nextMonth > 11) {
    nextMonth = 0;
    nextYear += 1;
  }
  const end = startFor(nextYear, nextMonth);

  // A period can never start before the account did, or the first one
  // would include usage from before signup -- which is impossible, but a
  // period boundary earlier than `createdAt` is still a lie in the
  // response the billing screen renders.
  const clampedStart = start.getTime() < created.getTime() ? created : start;
  return { start: clampedStart.toISOString(), end: end.toISOString() };
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Real counts, read from the append-only ledger.
 *
 * An account with no plan reports an allowance of zero rather than an
 * error: the billing screen can then render honestly ("0 of 0") instead of
 * having to special-case a failed request, and zero is also the truth.
 */
export async function computeUsage(account: AccountRecord, now: Date = new Date()): Promise<Usage> {
  const { start, end } = billingPeriod(account, now);
  const entries = await listUsage(account.id, start, end);

  const plan: PlanLimits | null = account.planId ? PLANS[account.planId] : null;
  const reelsUsed = entries.filter((e) => e.kind === "reel").length;
  const dubSecondsUsed = entries
    .filter((e) => e.kind === "dub")
    .reduce((total, e) => total + (e.seconds ?? 0), 0);

  const dubSecondsIncluded = (plan?.dubMinutes ?? 0) * 60;
  const overageSeconds = Math.max(0, dubSecondsUsed - dubSecondsIncluded);
  // Reels are a hard cap, never billed past the allowance, so they cannot
  // contribute here. Dubbing is the only metered thing in the catalogue.
  const overageDue = round2((overageSeconds / 60) * DUB_OVERAGE_PER_MINUTE[account.region]);

  return {
    periodStart: start,
    periodEnd: end,
    reelsUsed,
    reelsIncluded: plan?.reels ?? 0,
    dubSecondsUsed,
    dubSecondsIncluded,
    overageDue,
  };
}

/** A refusal a route can send straight back, or `null` for "allowed". */
export interface Refusal {
  readonly status: number;
  readonly error: string;
  readonly field?: string;
}

/**
 * Nothing metered happens before a plan is chosen.
 *
 * The web app already redirects to `/choose-plan` when `planId` is null,
 * but that is a redirect, not a control: this API is reachable with a
 * token and curl. Refused here so the gate exists in the one place that
 * can enforce it.
 */
export function requirePlan(account: AccountRecord, now: Date = new Date()): Refusal | null {
  if (!account.planId) {
    return {
      status: 403,
      error: "Choose a plan before creating or editing a project.",
      field: "planId",
    };
  }
  // With payments on, a plan is what was paid for, and only until the
  // period paid for ends. Without them, a chosen plan is the whole story.
  if (paymentsRequired && (!account.paidThrough || account.paidThrough <= now.toISOString())) {
    return {
      status: 402,
      error: account.paidThrough
        ? "Your plan ended on " + account.paidThrough.slice(0, 10) + ". Renew it to keep creating."
        : "Pay for your plan to start creating.",
      field: "planId",
    };
  }
  return null;
}

/**
 * Whether a plan has to be paid for. Set once at boot by `buildApp`, from
 * whether a payment gateway is configured -- a module flag rather than a
 * parameter, because `requirePlan` is called from five routes that have no
 * other reason to know about payments.
 */
let paymentsRequired = false;
export function setPaymentsRequired(required: boolean): void {
  paymentsRequired = required;
}

/**
 * Whether this account's plan includes dubbing at all.
 *
 * Starter is zero, so this is a refusal and not an overage: the plan page
 * lists lip-synced dubbing as "Creator and above", and metering a Starter
 * account for something its plan says it does not have would be a
 * surprise charge. The message names the plans that do include it, taken
 * from the plan table rather than written out, so it stays true.
 */
export function checkDubEntitlement(account: AccountRecord): Refusal | null {
  const planRefusal = requirePlan(account);
  if (planRefusal) return planRefusal;

  const plan = PLANS[account.planId as NonNullable<AccountRecord["planId"]>];
  if (plan.dubMinutes > 0) return null;

  const allowed = plansIncludingDubbing().map((p) => p.name);
  const names =
    allowed.length <= 1
      ? (allowed[0] ?? "a higher plan")
      : allowed.slice(0, -1).join(", ") + " and " + allowed[allowed.length - 1];
  return {
    status: 403,
    error:
      "Lip-synced dubbing is not included on " +
      plan.name +
      ". " +
      names +
      " include it. Change your plan to dub this reel.",
    field: "planId",
  };
}

/**
 * The message for a reel cap that has already been reached.
 *
 * The count itself is spent inside the store, under its write lock, so
 * that a burst of requests cannot all pass the same stale check -- see
 * `spendReelAllowance`. This only words the refusal.
 */
export function reelCapRefusal(plan: PlanLimits, period: { end: string }): Refusal {
  const resets = new Date(period.end).toISOString().slice(0, 10);
  return {
    status: 403,
    error:
      "This billing period's " +
      plan.reels +
      " reels on " +
      plan.name +
      " are used up. The allowance resets on " +
      resets +
      ". Change your plan to carry on now.",
    field: "planId",
  };
}
