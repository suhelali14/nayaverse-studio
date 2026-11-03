import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CATALOGUE } from "../../../studio/src/lib/catalogue.js";
import { env } from "../config/env.js";
import { authorize } from "../lib/access.js";
import { AiUnavailable } from "../lib/ai.js";
import { runAi } from "../lib/ai-gateway.js";
import { invalidBody, sendError } from "../lib/http.js";
import { getGeneration, insertGeneration, listGenerations, updateGeneration, type AccountRecord, type GenerationRecord } from "../lib/store.js";
import { DURATIONS, failureMessage, type ShotPrompter, type VideoGenerator } from "../lib/video-gen.js";

/**
 * AI video, through the same gate as every other AI call.
 *
 *   POST /api/ai/shot-prompt      a prompt for the shot under a line, to edit
 *   GET  /api/ai/video/allowance  seconds used and left this month
 *   POST /api/ai/video            start a clip from a prompt (and a still)
 *   GET  /api/ai/video/:id        where it is; fetches it home once made
 *   GET  /api/ai/video/:id/file   the finished clip, for its owner only
 *
 * No background worker: the provider is asked how a clip is going when the
 * editor asks us, and the clip is downloaded into our own storage the moment
 * it is ready, because the provider's link expires within a day or two.
 * Seconds count from the moment a clip is started -- the provider charges
 * for attempts it then moderates -- against the plan's monthly allowance.
 */

const MAX_FILE = 200 * 1024 * 1024;
// Runway's limit for an image sent inline is 5MB of data URI.
const IMAGE_URI = /^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/;

const monthStart = (now = new Date()): string => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
const allowanceOf = (account: AccountRecord): number => CATALOGUE.plans.find((p) => p.id === account.planId)?.videoSecondsPerMonth ?? 0;
const usedBy = async (account: AccountRecord): Promise<number> =>
  (await listGenerations(account.id, monthStart())).filter((g) => g.taskId !== null).reduce((t, g) => t + g.seconds, 0);

const publicView = (g: GenerationRecord) => ({
  id: g.id,
  status: g.status,
  seconds: g.seconds,
  prompt: g.prompt,
  message: g.message,
  createdAt: g.createdAt,
  finishedAt: g.finishedAt,
});

export async function videoRoutes(
  app: FastifyInstance,
  options: { generator: VideoGenerator | null; prompter: ShotPrompter | null; fetcher?: typeof fetch },
) {
  const { generator, prompter } = options;
  const fetcher = options.fetcher ?? fetch;
  const fetching = new Set<string>();
  const dir = join(env.UPLOAD_DIR, "generated");

  const notSetUp = (reply: Parameters<typeof sendError>[0]) =>
    sendError(reply, 503, "AI video is not set up on this server yet. Your own footage and the stock of the editor work as before.");

  const shotSchema = z.object({
    line: z.string().trim().min(1).max(300),
    visual: z.string().trim().max(120).default(""),
    topic: z.string().trim().max(300).default(""),
  });
  app.post("/api/ai/shot-prompt", async (request, reply) => {
    const account = authorize(request, reply, "plan:active");
    if (!account) return;
    if (!prompter) return sendError(reply, 503, "AI prompts are not set up on this server. Describe the shot yourself.");
    const parsed = shotSchema.safeParse(request.body);
    if (!parsed.success) return invalidBody(reply, parsed.error);
    try {
      const prompt = await runAi(account, "shot", prompter.name, () => prompter.write(parsed.data));
      return { prompt };
    } catch (error) {
      if (error instanceof AiUnavailable) return sendError(reply, error.status, error.publicMessage);
      throw error;
    }
  });

  app.get("/api/ai/video/allowance", async (request, reply) => {
    const account = authorize(request, reply, "plan:active");
    if (!account) return;
    return { used: await usedBy(account), limit: allowanceOf(account), configured: generator !== null, durations: DURATIONS };
  });

  const startSchema = z.object({
    prompt: z.string().trim().min(10, "Describe the shot in a sentence or two.").max(1000),
    seconds: z.union([z.literal(5), z.literal(10)]).default(5),
    image: z.string().max(5_000_000).regex(IMAGE_URI, "The picture must be a JPEG, PNG or WebP.").nullable().optional(),
  });
  app.post("/api/ai/video", { bodyLimit: 6 * 1024 * 1024 }, async (request, reply) => {
    const account = authorize(request, reply, "plan:active");
    if (!account) return;
    if (!generator) return notSetUp(reply);
    const parsed = startSchema.safeParse(request.body);
    if (!parsed.success) return invalidBody(reply, parsed.error);
    const limit = allowanceOf(account);
    if (limit === 0) return sendError(reply, 403, "AI video is not part of your plan. A larger plan includes it.");
    const used = await usedBy(account);
    if (used + parsed.data.seconds > limit) {
      return sendError(reply, 429, `That would take you past this month's ${limit} seconds of AI video (${used} used). It resets on the 1st, or a larger plan has more.`);
    }
    const record = await insertGeneration({
      accountId: account.id,
      provider: generator.provider,
      model: generator.model,
      prompt: parsed.data.prompt,
      seconds: parsed.data.seconds,
      status: "running",
      taskId: null,
    });
    try {
      const taskId = await generator.start({ prompt: parsed.data.prompt, seconds: parsed.data.seconds, image: parsed.data.image ?? null });
      const started = await updateGeneration(record.id, { taskId });
      return publicView(started ?? record);
    } catch (error) {
      // Not started, so not charged and not counted.
      const message = error instanceof AiUnavailable ? error.publicMessage : "The video could not be started.";
      await updateGeneration(record.id, { status: "failed", message, failureCode: "START", finishedAt: new Date().toISOString() });
      if (error instanceof AiUnavailable) return sendError(reply, error.status, error.publicMessage);
      throw error;
    }
  });

  const own = async (request: Parameters<typeof authorize>[0], reply: Parameters<typeof authorize>[1]) => {
    const account = authorize(request, reply, "plan:active");
    if (!account) return null;
    const { id } = request.params as { id: string };
    const g = await getGeneration(id);
    // Someone else's clip is not found, rather than forbidden: no hint it exists.
    if (!g || g.accountId !== account.id) {
      sendError(reply, 404, "No such clip.");
      return null;
    }
    return g;
  };

  app.get("/api/ai/video/:id", async (request, reply) => {
    const g = await own(request, reply);
    if (!g) return;
    if (g.status !== "running" || !g.taskId || !generator || fetching.has(g.id)) return publicView(g);
    let state;
    try {
      state = await generator.check(g.taskId);
    } catch (error) {
      // A failed check is not a failed clip: report it as still running.
      request.log.warn({ err: error instanceof Error ? error.message : String(error) }, "video check failed");
      return publicView(g);
    }
    if (state.state === "running") return publicView(g);
    if (state.state === "failed") {
      request.log.info({ code: state.code }, "video generation failed");
      const done = await updateGeneration(g.id, { status: "failed", failureCode: state.code, message: state.message, finishedAt: new Date().toISOString() });
      return publicView(done ?? g);
    }
    fetching.add(g.id);
    try {
      const res = await fetcher(state.url);
      if (!res.ok) throw new Error(`download ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_FILE) throw new Error(`download size ${bytes.length}`);
      await mkdir(dir, { recursive: true });
      const file = `${g.id}.mp4`;
      await writeFile(join(dir, file), bytes);
      const done = await updateGeneration(g.id, { status: "ready", file, finishedAt: new Date().toISOString() });
      return publicView(done ?? g);
    } catch (error) {
      request.log.warn({ err: error instanceof Error ? error.message : String(error) }, "video download failed");
      return publicView(g);
    } finally {
      fetching.delete(g.id);
    }
  });

  app.get("/api/ai/video/:id/file", async (request, reply) => {
    const g = await own(request, reply);
    if (!g) return;
    if (g.status !== "ready" || !g.file) return sendError(reply, 404, "This clip is not ready.");
    const path = join(dir, g.file);
    const info = await stat(path).catch(() => null);
    if (!info) return sendError(reply, 404, "This clip is no longer stored.");
    reply.header("Content-Type", "video/mp4");
    reply.header("Content-Length", String(info.size));
    reply.header("Cache-Control", "private, no-store");
    return reply.send(createReadStream(path));
  });
}

export { failureMessage };
