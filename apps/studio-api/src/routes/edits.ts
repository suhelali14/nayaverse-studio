import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { invalidBody, sendError } from "../lib/http.js";
import { findProject, getEdit, saveEdit } from "../lib/store.js";
import { requireAccount } from "../plugins/auth.js";

/**
 * A reel's edit, saved as it is made.
 *
 *   GET /api/projects/:id/edit   the last saved edit and its revision
 *   PUT /api/projects/:id/edit   save, based on a revision; 409 if stale
 *
 * The editor saves a second after each change. The document is checked here
 * -- its shape, its size, every clip's numbers -- because it is the creator's
 * work and must come back exactly as it went in; a malformed one is refused
 * rather than stored and found broken on the next open. Media is referred to
 * by name only: the files stay on the creator's machine.
 */

/** Generous for a reel: a 90-second, 40-clip edit with word timings is ~100KB. */
export const MAX_EDIT_BYTES = 1_500_000;

const seconds = z.number().finite().min(0).max(36_000);
const name = z.string().max(260);

const sourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("clip"), path: name, from: seconds, to: seconds }).passthrough(),
  z.object({ kind: z.literal("photo"), path: name }).passthrough(),
  z.object({ kind: z.literal("asset"), path: name }).passthrough(),
  z.object({ kind: z.literal("solid") }).passthrough(),
]);

const clipSchema = z
  .object({
    id: z.string().min(1).max(80),
    start: seconds,
    duration: z.number().finite().positive().max(36_000),
    sourceIn: seconds,
    caption: z.string().max(2_000),
    source: sourceSchema,
    volume: z.number().finite().min(0).max(4).optional(),
    speed: z.number().finite().min(0.1).max(8).optional(),
    grade: z
      .object({ exposure: z.number().finite(), contrast: z.number().finite(), saturation: z.number().finite(), warmth: z.number().finite() })
      .optional(),
    zoom: z.object({ from: z.number().finite().min(0.5).max(4), to: z.number().finite().min(0.5).max(4) }).optional(),
    fadeIn: seconds.optional(),
    fadeOut: seconds.optional(),
  })
  .passthrough();

const docSchema = z.object({
  version: z.literal(1),
  timeline: z.object({
    fps: z.number().int().min(1).max(120),
    tracks: z
      .array(z.object({ id: z.string().min(1).max(20), kind: z.enum(["video", "overlay", "audio"]), clips: z.array(clipSchema).max(500) }))
      .max(8),
  }),
  markers: z.array(seconds).max(200),
  captionStyle: z.object({ size: z.string().max(8), position: z.string().max(12), colour: z.string().max(12) }).passthrough(),
  media: z.array(z.object({ name, kind: z.enum(["photo", "clip", "audio"]), seconds: seconds.nullable() })).max(500),
  shots: z.array(z.tuple([z.string().max(80), z.unknown()])).max(200),
  scripted: z.array(z.tuple([z.string().max(80), z.array(z.unknown()).max(200)])).max(200),
});

export type EditDoc = z.infer<typeof docSchema>;

const idSchema = z.object({ id: z.string().min(1) });
const NOT_FOUND = "That project does not exist, or is not yours.";

export async function editRoutes(app: FastifyInstance) {
  app.get("/api/projects/:id/edit", async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    const params = idSchema.safeParse(request.params);
    if (!params.success) return invalidBody(reply, params.error);
    if (!(await findProject(account.id, params.data.id))) return sendError(reply, 404, NOT_FOUND);
    const edit = await getEdit(params.data.id);
    reply.header("Cache-Control", "no-store");
    return edit ? { revision: edit.revision, savedAt: edit.savedAt, doc: edit.doc } : { revision: 0, savedAt: null, doc: null };
  });

  const putSchema = z.object({ baseRevision: z.number().int().min(0), doc: docSchema });
  app.put("/api/projects/:id/edit", { bodyLimit: MAX_EDIT_BYTES + 4096 }, async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    const params = idSchema.safeParse(request.params);
    if (!params.success) return invalidBody(reply, params.error);
    if (!(await findProject(account.id, params.data.id))) return sendError(reply, 404, NOT_FOUND);
    const parsed = putSchema.safeParse(request.body);
    if (!parsed.success) return invalidBody(reply, parsed.error);
    const bytes = Buffer.byteLength(JSON.stringify(parsed.data.doc));
    if (bytes > MAX_EDIT_BYTES) return sendError(reply, 413, "This edit is too large to save. Split the reel into two.");
    const result = await saveEdit({ projectId: params.data.id, accountId: account.id, baseRevision: parsed.data.baseRevision, doc: parsed.data.doc, bytes });
    if (!result.ok) {
      return reply.status(409).send({
        error: "This reel was saved from another tab or device since you opened it.",
        revision: result.current.revision,
        savedAt: result.current.savedAt,
      });
    }
    return { revision: result.edit.revision, savedAt: result.edit.savedAt };
  });
}
