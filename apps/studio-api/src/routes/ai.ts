import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  DEFAULT_STYLE,
  improvePlan,
  planFromScript,
  planRenderable,
  validatePlan,
  type PlanModel,
} from "../../../studio/src/lib/scenes.js";
import { AiUnavailable } from "../lib/ai.js";
import { authorize } from "../lib/access.js";
import { aiAllowance, runAi } from "../lib/ai-gateway.js";
import { invalidBody, sendError } from "../lib/http.js";
import { requireAccount } from "../plugins/auth.js";

/**
 * The Director's server half: turn a script or a topic into a scene plan.
 *
 * Three modes, and only two of them need a model:
 *
 *   cut      the creator's script, split into hook, scenes and an ask by
 *            rules in `scenes.ts`. No key, no network, no cost.
 *   tighten  the creator's script, edited by the model.
 *   write    a topic, drafted by the model.
 *
 * All three return the same shape and every plan -- generated or not -- is
 * judged by the same `validatePlan`, so the editor never has to know which
 * path produced what it is showing.
 */

export interface AiRouteOptions {
  /** Null when no key is configured. Injected so tests never call out. */
  readonly planModel: PlanModel | null;
  /** Per IP, per minute. Each `write` or `tighten` costs a model call. */
  readonly planRateLimitMax: number;
}

const languageTag = z
  .string()
  .trim()
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/, "That is not a language code.");

/**
 * Bounds chosen against the job, not as generic hygiene.
 *
 * 6,000 characters is several minutes of narration -- far past anything a
 * reel can hold -- so a longer paste is a mistake and not a long reel.
 * Eighty file names is a large phone library, and the names go into the
 * model's prompt, where every one costs tokens.
 */
const planSchema = z.object({
  mode: z.enum(["cut", "tighten", "write"], {
    errorMap: () => ({ message: "Choose cut, tighten or write." }),
  }),
  text: z
    .string({ required_error: "Paste a script, or describe the reel." })
    .trim()
    .min(3, "Paste a script, or describe the reel.")
    .max(6000, "That is longer than any reel. Paste the part you want cut."),
  language: languageTag.default("en"),
  audience: z.string().trim().max(200, "Keep the audience to a sentence.").optional(),
  library: z
    .array(z.string().trim().min(1).max(160))
    .max(80, "That is more files than one reel can use. Send the ones for this reel.")
    .default([]),
});

export async function aiRoutes(app: FastifyInstance, options: AiRouteOptions) {
  /**
   * What this server can do, so the editor does not have to guess.
   *
   * The editor enables "write it for me" from this answer rather than from
   * a build flag, which is the difference between one deployment without a
   * key showing a button that always fails and showing the honest one.
   */
  app.get("/api/ai/status", async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    return {
      cut: true,
      write: options.planModel !== null,
      model: options.planModel?.name ?? null,
      style: DEFAULT_STYLE,
    };
  });

  /** Today's AI allowance, for the editor to show before a request fails. */
  app.get("/api/ai/usage", async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    return aiAllowance(account);
  });

  app.post(
    "/api/ai/plan",
    { config: { rateLimit: { max: options.planRateLimitMax, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const account = authorize(request, reply, "plan:active");
      if (!account) return;

      const parsed = planSchema.safeParse(request.body);
      if (!parsed.success) return invalidBody(reply, parsed.error);
      const { mode, text, language, audience, library } = parsed.data;

      if (mode === "cut") {
        const plan = planFromScript(text, DEFAULT_STYLE);
        const problems = validatePlan(plan, DEFAULT_STYLE);
        return {
          plan,
          problems,
          renderable: planRenderable(problems),
          source: "rules" as const,
          model: null,
          attempts: 0,
        };
      }

      const model = options.planModel;
      if (!model) {
        return sendError(
          reply,
          503,
          mode === "write"
            ? "AI writing is not set up on this server. Paste your own script and choose Cut -- that needs no AI."
            : "AI editing is not set up on this server. Choose Cut to split your script as written.",
          "mode",
        );
      }

      try {
        const result = await runAi(account, "plan", model.name, () =>
          improvePlan(model, text, DEFAULT_STYLE, {
            mode,
            language,
            audience: audience ?? null,
            library,
          }),
        );
        return {
          plan: result.plan,
          problems: result.problems,
          renderable: planRenderable(result.problems),
          source: "model" as const,
          model: model.name,
          attempts: result.attempts,
        };
      } catch (error) {
        if (error instanceof AiUnavailable) {
          // The provider's own words go to the log, where whoever runs the
          // server can act on them, and not to the creator.
          request.log.warn({ status: error.status, detail: error.detail }, "ai plan failed");
          return sendError(reply, error.status, error.publicMessage);
        }
        throw error;
      }
    },
  );
}
