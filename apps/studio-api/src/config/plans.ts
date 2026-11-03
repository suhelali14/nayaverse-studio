import {
  CATALOGUE,
  METERED,
  PLAN_IDS,
  REGIONS,
  type PlanId,
  type Region,
} from "../../../studio/src/lib/catalogue.js";

/**
 * Plan allowances, as the API enforces them -- derived, never copied.
 *
 * The catalogue in `apps/studio/src/lib/catalogue.ts` is the one
 * definition of what each plan contains and costs. This file narrows it to
 * the numbers an API has to enforce: reels, dub minutes, channels, and the
 * metered dub rate. It used to hold its own copy of those numbers, kept in
 * step with the web app's copy by a test that read that file off disk; a
 * derived value cannot drift, so the test now checks the property itself.
 *
 * Every figure traces, through the catalogue, to
 * `apps/studio/docs/PRICING.md`.
 */

export { PLAN_IDS, REGIONS, type PlanId, type Region };

export interface PlanLimits {
  readonly id: PlanId;
  /** Spelled as a message to a customer spells it. */
  readonly name: string;
  /** Reels scripted, cut and captioned per billing period. A hard cap. */
  readonly reels: number;
  /** Minutes of lip-synced dubbing included per period. Metered beyond. */
  readonly dubMinutes: number;
  readonly channels: number;
}

export const PLANS: Readonly<Record<PlanId, PlanLimits>> = Object.fromEntries(
  CATALOGUE.plans.map((p) => [
    p.id,
    { id: p.id, name: p.name, reels: p.reels, dubMinutes: p.dubMinutes, channels: p.channels },
  ]),
) as Record<PlanId, PlanLimits>;

/** What a minute of dubbing costs past the included allowance. */
export const DUB_OVERAGE_PER_MINUTE: Readonly<Record<Region, number>> = METERED.dubMinute;

/**
 * The plans that include any dubbing at all, named for a refusal message.
 *
 * Derived rather than written out, so raising Starter off zero one day
 * fixes the message instead of leaving a stale one lying in a string.
 */
export const plansIncludingDubbing = (): readonly PlanLimits[] =>
  PLAN_IDS.map((id) => PLANS[id]).filter((plan) => plan.dubMinutes > 0);
