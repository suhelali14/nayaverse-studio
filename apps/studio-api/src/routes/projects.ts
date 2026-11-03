import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { PLANS } from "../config/plans.js";
import { invalidBody, sendError, sendRefusal } from "../lib/http.js";
import { toJob, toProject, toTranscript } from "../lib/mappers.js";
import {
  appendUsage,
  createProjectWithinAllowance,
  deleteProject,
  findProject,
  findTranscript,
  insertJob,
  listProjects,
  listJobs,
  updateProject,
  type AccountRecord,
  type ProjectRecord,
} from "../lib/store.js";
import { footagePath, removeFootage, saveFootage } from "../lib/uploads.js";
import { probeDuration } from "../lib/probe.js";
import { billingPeriod, checkDubEntitlement, reelCapRefusal, requirePlan } from "../lib/usage.js";
import { resolveProvider } from "../lib/worker.js";
import { requireAccount } from "../plugins/auth.js";

/**
 * Projects, footage and the three jobs that act on them.
 *
 * ── Ownership ────────────────────────────────────────────────────────
 *
 * Every route here loads its project through `ownedProject`, which calls
 * `findProject(account.id, id)` -- and the store exports no way to fetch a
 * project by id alone, so forgetting the check is not something a future
 * route can do by omission.
 *
 * A project belonging to someone else answers **404, not 403**. 403 would
 * confirm that the id exists, which turns a guessable id into a way to
 * enumerate other people's work; "not found" is also true from the
 * caller's point of view, since there is no project by that id that they
 * can see.
 */

const idSchema = z.object({ id: z.string().min(1) });

/**
 * A language tag, loosely.
 *
 * `hi`, `pt-BR`. Validated for shape only: the catalogue of languages the
 * product offers is `DUB_TARGETS` in `apps/studio/src/lib/catalogue.ts`,
 * and mirroring a fourteen-row table here to re-check what the UI already
 * constrains would be a second thing to keep in step for no safety.
 */
const languageTag = z
  .string()
  .trim()
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/, "That is not a language code.");

const createProjectSchema = z.object({
  title: z
    .string({ required_error: "Give the reel a title." })
    .trim()
    .min(1, "Give the reel a title.")
    .max(200, "That title is too long."),
  language: languageTag,
});

const transcribeSchema = z.object({
  /**
   * Null means detect, which is what the contract sends. `.nullable()`
   * rather than `.optional()`: the client always sends the key, and a
   * missing key is a different caller making a different mistake.
   */
  language: languageTag.nullable(),
});

const dubSchema = z.object({
  language: languageTag,
  lipSync: z.boolean({
    required_error: "Say whether to lip-sync this dub.",
    invalid_type_error: "lipSync must be true or false.",
  }),
});

/** The one 404, worded the same everywhere so the two cases are one case. */
const NOT_FOUND = "That project does not exist, or is not yours.";

async function ownedProject(
  account: AccountRecord,
  id: string,
  reply: FastifyReply,
): Promise<ProjectRecord | null> {
  const project = await findProject(account.id, id);
  if (!project) {
    sendError(reply, 404, NOT_FOUND);
    return null;
  }
  return project;
}

/**
 * Nothing can be transcribed, dubbed or rendered before there is footage.
 *
 * A job over an empty project would reach the worker, fail there, and tell
 * the user "there is no footage on this project any more" -- which is a
 * confusing way to say "upload something first".
 */
function requireFootage(project: ProjectRecord, reply: FastifyReply): boolean {
  if (project.footage) return true;
  sendError(reply, 409, "Upload footage to this project first.", "file");
  return false;
}

export async function projectRoutes(app: FastifyInstance) {
  app.get("/api/projects", async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    return (await listProjects(account.id)).map(toProject);
  });

  /**
   * Create a project, which is what spends a reel from the allowance.
   *
   * A reel is counted here rather than at render, because this is the
   * point at which the user has committed to one and the point at which
   * refusing is still useful: telling somebody their month is full after
   * they have uploaded and cut a video is telling them too late.
   *
   * The count and the insert happen together inside the store's write
   * lock -- see `createProjectWithinAllowance` -- so a burst cannot all
   * pass the same stale check.
   */
  app.post("/api/projects", async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;

    const parsed = createProjectSchema.safeParse(request.body);
    if (!parsed.success) return invalidBody(reply, parsed.error);

    const planRefusal = requirePlan(account);
    if (planRefusal) return sendRefusal(reply, planRefusal);
    const plan = PLANS[account.planId as NonNullable<AccountRecord["planId"]>];

    const period = billingPeriod(account);
    const result = await createProjectWithinAllowance({
      accountId: account.id,
      title: parsed.data.title,
      language: parsed.data.language,
      periodStart: period.start,
      periodEnd: period.end,
      reelsIncluded: plan.reels,
    });
    if (!result.ok) return sendRefusal(reply, reelCapRefusal(plan, period));

    return reply.status(201).send(toProject(result.project));
  });

  app.get("/api/projects/:id", async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    const params = idSchema.safeParse(request.params);
    if (!params.success) return invalidBody(reply, params.error);

    const project = await ownedProject(account, params.data.id, reply);
    if (!project) return;
    return toProject(project);
  });

  /**
   * 204, and the footage goes with it.
   *
   * The usage ledger does not: deleting a project does not un-spend the
   * reel it cost. See `UsageEntry` in `lib/store.ts` -- otherwise the
   * monthly cap is reset by whoever wants it reset.
   */
  app.delete("/api/projects/:id", async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    const params = idSchema.safeParse(request.params);
    if (!params.success) return invalidBody(reply, params.error);

    const removed = await deleteProject(account.id, params.data.id);
    if (!removed) return sendError(reply, 404, NOT_FOUND);
    if (removed.footage) await removeFootage(removed.footage.storedName);
    return reply.status(204).send();
  });

  /**
   * Upload the footage.
   *
   * The file-size cap, the mimetype allowlist and the generated storage
   * name all live in `lib/uploads.ts`; this route's own job is ownership
   * and the project row.
   */
  app.post("/api/projects/:id/footage", async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    const params = idSchema.safeParse(request.params);
    if (!params.success) return invalidBody(reply, params.error);

    const project = await ownedProject(account, params.data.id, reply);
    if (!project) return;

    // Ownership is checked before the body is touched, so a stranger
    // guessing ids cannot make us write their gigabyte to our disk.
    let file;
    try {
      file = await request.file();
    } catch (error: unknown) {
      // Thrown by the parser for a body that is not multipart at all, and
      // for one that blew the configured limits before any field arrived.
      const message =
        error instanceof Error && /too large|limit/i.test(error.message)
          ? "That file is over the upload limit."
          : "Send the footage as a multipart form with the file in a field named `file`.";
      return sendError(reply, 400, message, "file");
    }
    if (!file) {
      return sendError(reply, 400, "Attach a file in a field named `file`.", "file");
    }

    const saved = await saveFootage(file);
    if (!saved.ok) return sendError(reply, saved.status, saved.error, saved.field);

    // Replacing footage leaves the old file orphaned otherwise, and
    // footage is the largest thing this product stores.
    if (project.footage) await removeFootage(project.footage.storedName);

    // Before the update rather than after, so the row is written once
    // with the figure it will be billed on.
    const probed = await probeDuration(footagePath(saved.footage.storedName));

    const updated = await updateProject(
      project.id,
      {
        footage: saved.footage,
        // Footage on a project means it is being edited, not a blank
        // draft. A project that has already rendered keeps its status --
        // replacing the footage of a finished reel does not un-finish it,
        // it just means the next render will differ.
        ...(project.status === "draft" ? { status: "editing" as const } : {}),
        // Measured, not taken on trust. Dubbing is billed per minute of
        // finished video, so a duration the client chose is a duration the
        // payer chose. The client's own figure is kept only as the
        // fallback when the file cannot be read, and is marked as such.
        ...(probed !== null
          ? { seconds: probed.seconds, secondsSource: "probe" as const }
          : saved.seconds === null
            ? {}
            : { seconds: saved.seconds, secondsSource: "client" as const }),
      },
      account.id,
    );
    if (!updated) return sendError(reply, 404, NOT_FOUND);
    return toProject(updated);
  });

  /**
   * Queue a transcription. Returns the job, not the transcript.
   *
   * Not metered: auto-subtitles are included on every plan (see the plan
   * lines in `apps/studio/src/lib/catalogue.ts`), so there is nothing to
   * spend and nothing to refuse beyond having a plan at all.
   */
  app.post("/api/projects/:id/transcribe", async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    const params = idSchema.safeParse(request.params);
    if (!params.success) return invalidBody(reply, params.error);
    const parsed = transcribeSchema.safeParse(request.body);
    if (!parsed.success) return invalidBody(reply, parsed.error);

    const planRefusal = requirePlan(account);
    if (planRefusal) return sendRefusal(reply, planRefusal);

    const project = await ownedProject(account, params.data.id, reply);
    if (!project) return;
    if (!requireFootage(project, reply)) return;

    const provider = resolveProvider();
    const job = await insertJob({
      accountId: account.id,
      projectId: project.id,
      kind: "transcribe",
      simulated: provider?.simulated ?? false,
      ...(parsed.data.language === null ? {} : { language: parsed.data.language }),
      message: "Queued.",
    });
    // 202: the work has been accepted and has not happened. The client
    // polls `GET /jobs?projectId=` from here, which is what its own
    // comment says it does.
    return reply.status(202).send(toJob(job));
  });

  app.get("/api/projects/:id/transcript", async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    const params = idSchema.safeParse(request.params);
    if (!params.success) return invalidBody(reply, params.error);

    // Checked even though `findTranscript` is also scoped by account: this
    // way a transcript that does not exist yet and a project that is not
    // yours give different, accurate messages, instead of both being "no
    // transcript".
    const project = await ownedProject(account, params.data.id, reply);
    if (!project) return;

    const transcript = await findTranscript(account.id, project.id);
    if (!transcript) {
      const jobs = await listJobs(account.id, project.id);
      const pending = jobs.find(
        (job) => job.kind === "transcribe" && (job.status === "queued" || job.status === "running"),
      );
      return sendError(
        reply,
        404,
        pending
          ? "This reel is still being transcribed."
          : "This reel has not been transcribed yet.",
      );
    }
    return toTranscript(transcript);
  });

  /**
   * Queue a dub. Metered, and refused outright on a plan that has none.
   *
   * The entitlement check runs before the footage check on purpose: "your
   * plan does not include dubbing" is the answer whatever state the
   * project is in, and sending somebody off to upload footage for a thing
   * they then cannot do is a worse order to learn it in.
   *
   * The usage entry is written now, when the job is queued, not when it
   * finishes. A dub is billed because a provider was asked to do it; and
   * recording it at the end would let a hundred simultaneous requests all
   * pass the allowance check before any of them had been counted.
   */
  app.post("/api/projects/:id/dub", async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    const params = idSchema.safeParse(request.params);
    if (!params.success) return invalidBody(reply, params.error);
    const parsed = dubSchema.safeParse(request.body);
    if (!parsed.success) return invalidBody(reply, parsed.error);

    const entitlement = checkDubEntitlement(account);
    if (entitlement) return sendRefusal(reply, entitlement);

    const project = await ownedProject(account, params.data.id, reply);
    if (!project) return;
    if (!requireFootage(project, reply)) return;

    // A dub is the transcript spoken in another language. Without one
    // there is nothing to say, and the provider would be asked to dub
    // silence at full price.
    const transcript = await findTranscript(account.id, project.id);
    if (!transcript) {
      return sendError(
        reply,
        409,
        "Transcribe this reel before dubbing it -- a dub is the transcript spoken in another language.",
      );
    }

    await appendUsage({
      accountId: account.id,
      kind: "dub",
      projectId: project.id,
      seconds: project.seconds,
      language: parsed.data.language,
    });

    const provider = resolveProvider();
    const job = await insertJob({
      accountId: account.id,
      projectId: project.id,
      kind: "dub",
      simulated: provider?.simulated ?? false,
      language: parsed.data.language,
      lipSync: parsed.data.lipSync,
      message: "Queued.",
    });
    return reply.status(202).send(toJob(job));
  });

  /**
   * Queue a render.
   *
   * Not metered on its own: the reel was counted when the project was
   * created, and charging again per render would mean a creator who
   * re-exports with one caption fixed pays twice for the same reel.
   */
  app.post("/api/projects/:id/render", async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    const params = idSchema.safeParse(request.params);
    if (!params.success) return invalidBody(reply, params.error);

    const planRefusal = requirePlan(account);
    if (planRefusal) return sendRefusal(reply, planRefusal);

    const project = await ownedProject(account, params.data.id, reply);
    if (!project) return;
    if (!requireFootage(project, reply)) return;

    const provider = resolveProvider();
    const job = await insertJob({
      accountId: account.id,
      projectId: project.id,
      kind: "render",
      simulated: provider?.simulated ?? false,
      message: "Queued.",
    });
    // Set here rather than waiting for the worker's first tick, so the
    // project the client re-reads straight after this call already says
    // `rendering` instead of flickering back to `editing`.
    await updateProject(project.id, { status: "rendering" }, account.id);
    return reply.status(202).send(toJob(job));
  });
}
