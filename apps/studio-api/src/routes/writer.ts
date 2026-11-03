import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DEFAULT_STYLE, speakingSeconds, validatePlan, type ScenePlan } from "../../../studio/src/lib/scenes.js";
import { authorize } from "../lib/access.js";
import { AiUnavailable } from "../lib/ai.js";
import { runAi } from "../lib/ai-gateway.js";
import { invalidBody, sendError } from "../lib/http.js";
import { buildReport } from "../../../studio/src/lib/insights.js";
import { listPosts, type AccountRecord } from "../lib/store.js";
import { checkNotes, type EditNotesModel } from "../lib/edit-notes.js";
import { historyFrom, type Brief, type SceneDraft, type ScriptVersion, type Writer } from "../lib/writer.js";

/**
 * The new-reel wizard's three steps, each a small request through the
 * gateway:
 *
 *   POST /api/ai/hooks     five opening lines for a brief
 *   POST /api/ai/scripts   three versions of the script on a chosen hook,
 *                          each with the claim checks' findings attached
 *   POST /api/ai/rewrite   one scene again, on an instruction
 */

const languageTag = z.string().trim().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "Choose a language from the list.");

const briefSchema = z.object({
  topic: z.string().trim().min(3, "Say what the reel is about.").max(600),
  audience: z.string().trim().max(200).optional(),
  language: languageTag.default("en"),
  tone: z.enum(["friendly", "expert", "bold", "story"]).default("friendly"),
  goal: z.enum(["educate", "sell", "entertain"]).default("educate"),
  seconds: z.number().int().min(15).max(90).default(30),
});

const scenesSchema = z
  .array(z.object({ text: z.string().trim().min(1).max(400), visual: z.string().trim().max(120).default("") }))
  .min(1)
  .max(12);

/**
 * The brief as the writer gets it, with what has worked on the creator's
 * own connected accounts, when there are enough posts to say.
 */
const toBrief = async (account: AccountRecord, b: z.infer<typeof briefSchema>): Promise<Brief> => ({
  ...b,
  audience: b.audience || null,
  history: historyFrom(buildReport(await listPosts(account.id))),
});

/** A version as a scene plan, so the same claim checks run on it. */
function asPlan(v: ScriptVersion): ScenePlan {
  const scene = (s: SceneDraft) => ({ text: s.text, visual: s.visual, seconds: speakingSeconds(s.text, DEFAULT_STYLE) });
  const [hook, ...rest] = v.scenes;
  // The ask plays over the last scene's footage, as an editor would cut it.
  const lastVisual = v.scenes[v.scenes.length - 1]?.visual ?? "";
  const cta = v.cta ? { text: v.cta, visual: lastVisual, seconds: speakingSeconds(v.cta, DEFAULT_STYLE) } : null;
  const all = [hook ? scene(hook) : { text: "", visual: "", seconds: 0 }, ...rest.map(scene), ...(cta ? [cta] : [])];
  return {
    hook: all[0]!,
    scenes: rest.map(scene),
    cta,
    totalSeconds: Number(all.reduce((t, s) => t + s.seconds, 0).toFixed(3)),
  };
}

export async function writerRoutes(app: FastifyInstance, options: { writer: Writer | null; editNotes: EditNotesModel | null }) {
  const { writer, editNotes } = options;

  const unavailable = (reply: Parameters<typeof sendError>[0]) =>
    sendError(reply, 503, "AI writing is not set up on this server. Write your script yourself and open it in the editor.");

  const fail = (reply: Parameters<typeof sendError>[0], error: unknown) => {
    if (error instanceof AiUnavailable) return sendError(reply, error.status, error.publicMessage);
    throw error;
  };

  app.post("/api/ai/hooks", async (request, reply) => {
    const account = authorize(request, reply, "plan:active");
    if (!account) return;
    if (!writer) return unavailable(reply);
    const parsed = briefSchema.safeParse(request.body);
    if (!parsed.success) return invalidBody(reply, parsed.error);
    const brief = await toBrief(account, parsed.data);
    try {
      const hooks = await runAi(account, "hooks", writer.name, () => writer.hooks(brief));
      return { hooks, model: writer.name };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post("/api/ai/scripts", async (request, reply) => {
    const account = authorize(request, reply, "plan:active");
    if (!account) return;
    if (!writer) return unavailable(reply);
    const parsed = briefSchema.extend({ hook: z.string().trim().min(3).max(200) }).safeParse(request.body);
    if (!parsed.success) return invalidBody(reply, parsed.error);
    const brief = await toBrief(account, parsed.data);
    try {
      const versions = await runAi(account, "scripts", writer.name, () => writer.scripts(brief, parsed.data.hook));
      return {
        model: writer.name,
        versions: versions.map((v) => {
          const plan = asPlan(v);
          return {
            ...v,
            seconds: plan.totalSeconds,
            problems: validatePlan(plan, DEFAULT_STYLE).map((p) => ({ detail: p.detail, blocking: p.blocking })),
          };
        }),
      };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post("/api/ai/rewrite", async (request, reply) => {
    const account = authorize(request, reply, "plan:active");
    if (!account) return;
    if (!writer) return unavailable(reply);
    const parsed = briefSchema
      .extend({ scenes: scenesSchema, index: z.number().int().min(0).max(11), instruction: z.string().trim().min(2).max(300) })
      .safeParse(request.body);
    if (!parsed.success) return invalidBody(reply, parsed.error);
    if (parsed.data.index >= parsed.data.scenes.length) return sendError(reply, 400, "That scene does not exist.", "index");
    const brief = await toBrief(account, parsed.data);
    try {
      const scene = await runAi(account, "scene", writer.name, () =>
        writer.rewrite(brief, parsed.data.scenes, parsed.data.index, parsed.data.instruction),
      );
      return { scene };
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * POST /api/ai/edit-notes -- the editor's pass, judgement half: one look
   * for the reel and the lines worth a push in. The measured half (beats,
   * stills, levels) is computed in the browser and needs no request.
   */
  const notesSchema = z.object({
    language: languageTag.default("en"),
    scenes: z
      .array(
        z.object({
          id: z.string().trim().min(1).max(64),
          text: z.string().trim().max(400).default(""),
          kind: z.enum(["clip", "photo", "solid"]),
          seconds: z.number().min(0).max(600),
        }),
      )
      .min(1)
      .max(40),
  });
  app.post("/api/ai/edit-notes", async (request, reply) => {
    const account = authorize(request, reply, "plan:active");
    if (!account) return;
    if (!editNotes) return sendError(reply, 503, "AI notes are not set up on this server. The rest of the editor's pass works without them.");
    const parsed = notesSchema.safeParse(request.body);
    if (!parsed.success) return invalidBody(reply, parsed.error);
    try {
      const notes = await runAi(account, "edit", editNotes.name, () => editNotes.notes(parsed.data.scenes, parsed.data.language));
      return { ...checkNotes(notes, parsed.data.scenes), model: editNotes.name };
    } catch (error) {
      return fail(reply, error);
    }
  });
}
