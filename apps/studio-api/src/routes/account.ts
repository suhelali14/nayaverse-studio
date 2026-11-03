import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PLAN_IDS } from "../config/plans.js";
import { invalidBody, sendError } from "../lib/http.js";
import { toAccount } from "../lib/mappers.js";
import { setAccountPlan } from "../lib/store.js";
import { computeUsage } from "../lib/usage.js";
import { requireAccount } from "../plugins/auth.js";

/** The two `/account/*` calls in the client contract. */

const planSchema = z.object({
  planId: z.enum(PLAN_IDS, {
    errorMap: () => ({ message: "Choose one of the Starter, Creator or Studio plans." }),
  }),
});

export async function accountRoutes(app: FastifyInstance, options: { paymentsOn: boolean }) {
  /**
   * Choosing or changing a plan.
   *
   * This is what unlocks the account when no payment gateway is configured
   * (development, and test mode): `planId` is null until it is called, and
   * `requirePlan` refuses everything metered while it is. With a gateway,
   * this route refuses and the plan comes from a paid checkout instead.
   *
   * Changing plan mid-period takes effect at once and does not move the
   * period boundary, which means the new allowance applies to usage
   * already spent this month. That is the generous direction on an
   * upgrade and the awkward one on a downgrade; proration needs a billing
   * provider to be honest about, and inventing it here would mean writing
   * numbers nobody can reconcile against an invoice.
   */
  app.post("/api/account/plan", async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;

    // With a payment gateway configured, a plan is bought through
    // /api/billing/checkout and nowhere else; this route would otherwise be
    // a free upgrade for anyone with a token and curl.
    if (options.paymentsOn) {
      return sendError(reply, 402, "Plans are bought through checkout on the Plan & billing page.", "planId");
    }

    const parsed = planSchema.safeParse(request.body);
    if (!parsed.success) return invalidBody(reply, parsed.error);

    const updated = await setAccountPlan(account.id, parsed.data.planId);
    if (!updated) {
      // The account was authenticated a moment ago, so this is a deleted
      // account racing its own request rather than a caller's mistake.
      return sendError(reply, 404, "That account no longer exists.");
    }
    return toAccount(updated);
  });

  /**
   * Real counts, from the append-only ledger -- never from the live rows.
   *
   * Counting an account's projects would mean deleting a project gives a
   * reel back, which turns the monthly cap into a suggestion. See
   * `UsageEntry` in `lib/store.ts`.
   */
  app.get("/api/account/usage", async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    return computeUsage(account);
  });
}
