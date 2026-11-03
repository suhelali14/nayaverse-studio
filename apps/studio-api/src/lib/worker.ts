import { env } from "../config/env.js";
import {
  claimNextQueuedJob,
  findProject,
  findTranscript,
  flushWrites,
  listStaleRunningJobs,
  putTranscript,
  updateJob,
  updateProject,
  type JobRecord,
  type ProjectRecord,
  type WordRecord,
} from "./store.js";
import { footagePath } from "./uploads.js";

/**
 * Transcribe, dub and render -- the three things this product does that
 * take longer than a request.
 *
 * ── The shape ────────────────────────────────────────────────────────
 *
 * A route creates a `Job` row with status `queued` and returns it at once.
 * This module picks queued rows up and moves them `queued -> running ->
 * done | failed`, writing progress as it goes. The client polls
 * `GET /jobs?projectId=`, which is what the contract says it does.
 *
 * It runs in this process. That is a deliberate stop short of a real queue
 * and it has one honest consequence: a restart mid-job loses the job, so
 * `recoverStaleJobs` below fails anything left `running` rather than
 * leaving a spinner turning forever. A real deployment replaces this file
 * with a worker process reading the same rows -- which is also the point
 * at which the store has to be Postgres, because two processes cannot
 * share the JSON file. See `lib/store.ts`.
 *
 * ── Nothing here calls a provider ────────────────────────────────────
 *
 * There is no ASR, dubbing or render provider wired in, and no API key for
 * one exists in this environment. So the only implementation of
 * `Provider` below is `simulation`, which invents plausible output on a
 * timer. It is gated behind `STUDIO_SIMULATE_JOBS` (default on outside
 * production, off inside it) and every row it writes carries
 * `simulated: true`, because a made-up transcript sitting in a database
 * looking exactly like a real one is a trap that gets discovered by a
 * customer.
 */

// ---------------------------------------------------------------------------
// The provider seam. This is the whole extension point.

/** Fraction done, 0..1, with an optional line for the UI. */
export type ReportProgress = (fraction: number, message?: string) => void;

export interface ProbeRequest {
  readonly projectId: string;
  /** Absolute path to the uploaded footage. */
  readonly sourcePath: string;
}

export interface TranscribeRequest {
  readonly projectId: string;
  readonly sourcePath: string;
  /** Null means "detect it", which is what the contract's `language: null`
   *  asks for. */
  readonly languageHint: string | null;
  readonly seconds: number;
}

export interface TranscribeResult {
  readonly language: string;
  /** What the recogniser thought it heard, when asked to detect. */
  readonly detectedLanguage: string | null;
  readonly words: readonly WordRecord[];
}

export interface DubRequest {
  readonly projectId: string;
  readonly sourcePath: string;
  readonly language: string;
  readonly lipSync: boolean;
  readonly seconds: number;
  /** The words to speak. A dub with no transcript has nothing to say. */
  readonly words: readonly WordRecord[];
}

export interface DubResult {
  /** Where the dubbed audio ended up, if the provider produced a file. */
  readonly audioUrl: string | null;
}

export interface RenderRequest {
  readonly projectId: string;
  readonly sourcePath: string;
  readonly seconds: number;
  readonly burnSubtitles: boolean;
}

export interface RenderResult {
  readonly videoUrl: string;
  readonly thumbnailUrl: string | null;
}

/**
 * Where a real ASR / dubbing / render provider plugs in.
 *
 * To add one -- say Deepgram for ASR and ElevenLabs for dubbing -- write
 * one file per provider exporting an object of this type, read its key
 * from `config/env.ts` (optional there, so a deployment without one still
 * boots), and return it from `resolveProvider` below. Nothing else in this
 * app changes: the routes, the job rows and the client contract are all
 * already in terms of this interface.
 *
 * Three things a real implementation owes the rest of the system:
 *
 *   - `simulated` must be `false`, and it must be the provider that says
 *     so rather than the worker assuming it.
 *   - `report` should be called as work lands, not interpolated on a
 *     timer. A progress bar that is a `setInterval` is a lie about the
 *     one thing the user is watching.
 *   - throw on failure with a message that can be shown to a customer.
 *     It is stored on the job and rendered.
 *
 * `probe` is optional and nothing implements it yet. It is the answer to
 * the one piece of client-supplied data this API currently bills on: see
 * `parseSeconds` in `lib/uploads.ts`.
 */
export interface Provider {
  readonly name: string;
  /** Whether output from this provider is invented. */
  readonly simulated: boolean;
  probe?(request: ProbeRequest): Promise<{ seconds: number }>;
  transcribe(request: TranscribeRequest, report: ReportProgress): Promise<TranscribeResult>;
  dub(request: DubRequest, report: ReportProgress): Promise<DubResult>;
  render(request: RenderRequest, report: ReportProgress): Promise<RenderResult>;
}

// ---------------------------------------------------------------------------
// The simulator.

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Walk a job from 0 to 1 over the configured duration.
 *
 * Six steps rather than a smooth ramp, because the point is to exercise
 * the polling client -- a job that is only ever 0 or 1 never proves the
 * progress field works.
 */
async function simulateProgress(report: ReportProgress, note: string): Promise<void> {
  const steps = 6;
  const perStep = Math.round(env.STUDIO_SIMULATE_MS / steps);
  for (let step = 1; step <= steps; step += 1) {
    await sleep(perStep);
    report(step / steps, note);
  }
}

/**
 * The sentence a simulated transcript says.
 *
 * It says what it is, deliberately. A simulated transcript of plausible
 * marketing copy would read as real in a screenshot, in a support ticket
 * and in a bug report six months from now; this one cannot be mistaken
 * for speech recognition by anybody who reads it. The `simulated` flag on
 * the row is the machine-readable half of the same idea.
 */
const SIMULATED_SENTENCE =
  "This transcript was produced by the Studio job simulator. " +
  "No speech recognition has run on this footage, and no provider is configured.";

/**
 * Word timings spread across the footage.
 *
 * `seconds` can be 0 when nobody told us how long the footage is (see
 * `lib/uploads.ts`), and a transcript whose words all start and end at
 * zero would make the subtitle editor look broken rather than empty. So a
 * nominal twelve seconds stands in -- the length of a short reel.
 */
function simulatedWords(seconds: number): WordRecord[] {
  const words = SIMULATED_SENTENCE.split(" ");
  const spanMs = Math.max(1, Math.round((seconds > 0 ? seconds : 12) * 1000));
  const perWord = Math.max(1, Math.floor(spanMs / words.length));
  return words.map((text, index) => {
    const startMs = index * perWord;
    return {
      text,
      startMs,
      // A 60 ms gap, so consecutive words do not share a boundary and the
      // subtitle grouper has something to group on.
      endMs: Math.min(spanMs, startMs + Math.max(1, perWord - 60)),
      // Deliberately varied and deliberately not 1.0: the contract says
      // low confidence is shown rather than hidden, and a column that is
      // always 1 never gets that path rendered.
      confidence: Math.round((0.72 + ((index * 7) % 23) / 100) * 100) / 100,
    };
  });
}

export const simulation: Provider = {
  name: "simulation",
  simulated: true,

  async transcribe(request, report) {
    await simulateProgress(report, "Simulating speech recognition");
    return {
      language: request.languageHint ?? "en",
      // Only claim a detection when one was asked for, which is what
      // `detectedLanguage: null` means in the contract.
      detectedLanguage: request.languageHint === null ? "en" : null,
      words: simulatedWords(request.seconds),
    };
  },

  async dub(request, report) {
    await simulateProgress(
      report,
      "Simulating a " + request.language + (request.lipSync ? " lip-synced" : "") + " dub",
    );
    // No file is produced, and no URL is invented for one. A URL pointing
    // at nothing is worse than null: null renders as "not ready", a dead
    // URL renders as a broken player.
    return { audioUrl: null };
  },

  async render(request, report) {
    await simulateProgress(report, "Simulating the render");
    return {
      // The path says what it is. A simulated render stored as
      // `/renders/<id>.mp4` is indistinguishable from a real one in the
      // database, in a log line and in a copied-out URL; this one is not.
      videoUrl: "/simulated/renders/" + request.projectId + ".mp4",
      // No frame extraction without a decoder, so no thumbnail rather
      // than a made-up one.
      thumbnailUrl: null,
    };
  },
};

/**
 * Which provider, if any, this deployment has.
 *
 * Returns null when simulation is off and nothing real is configured. The
 * worker then fails each job with a message saying so, rather than leaving
 * it `queued` forever -- a job that never moves looks like a bug in the
 * client and gets debugged from the wrong end.
 */
export function resolveProvider(): Provider | null {
  // A real provider goes here, first:
  //
  //   if (env.DEEPGRAM_API_KEY) return deepgram(env.DEEPGRAM_API_KEY);
  //
  // ...so that a deployment with both a key and the simulation flag left
  // on uses the real thing.
  if (env.SIMULATE_JOBS) return simulation;
  return null;
}

// ---------------------------------------------------------------------------
// The loop.

export interface JobWorker {
  stop(): Promise<void>;
}

/**
 * Fail anything left `running`.
 *
 * Called once at startup. A job is only `running` because this process set
 * it so, and this process has just started, so every such row is from a
 * previous life. Failing them with a reason is the honest outcome: the
 * work is genuinely gone, and the alternative is a client polling a job
 * that will never change again.
 */
async function recoverStaleJobs(log: (message: string) => void): Promise<void> {
  const stale = await listStaleRunningJobs();
  if (stale.length === 0) return;
  for (const job of stale) {
    await updateJob(job.id, {
      status: "failed",
      progress: null,
      message: "This job was interrupted by a server restart. Start it again.",
      finishedAt: new Date().toISOString(),
    });
    if (job.kind === "render") {
      await updateProject(job.projectId, { status: "failed" });
    }
  }
  log("failed " + stale.length + " job(s) left running by a previous process");
}

async function runJob(job: JobRecord, provider: Provider): Promise<void> {
  const project: ProjectRecord | null = await findProject(job.accountId, job.projectId);
  if (!project) {
    await updateJob(job.id, {
      status: "failed",
      progress: null,
      message: "The project this job belonged to was deleted.",
      finishedAt: new Date().toISOString(),
    });
    return;
  }
  if (!project.footage) {
    await updateJob(job.id, {
      status: "failed",
      progress: null,
      message: "There is no footage on this project any more.",
      finishedAt: new Date().toISOString(),
    });
    return;
  }

  const sourcePath = footagePath(project.footage.storedName);
  const report: ReportProgress = (fraction, message) => {
    // Fire and forget: progress is a nicety and must never be the reason a
    // job fails. Clamped because a provider is allowed to be sloppy about
    // the top end of its own ramp.
    void updateJob(job.id, {
      progress: Math.max(0, Math.min(1, fraction)),
      ...(message === undefined ? {} : { message }),
    });
  };

  const finishedAt = (): string => new Date().toISOString();

  if (job.kind === "transcribe") {
    const result = await provider.transcribe(
      {
        projectId: project.id,
        sourcePath,
        languageHint: job.language ?? null,
        seconds: project.seconds,
      },
      report,
    );
    await putTranscript({
      projectId: project.id,
      accountId: job.accountId,
      language: result.language,
      detectedLanguage: result.detectedLanguage,
      words: [...result.words],
      createdAt: finishedAt(),
      simulated: provider.simulated,
    });
    await updateProject(project.id, {
      hasSubtitles: true,
      language: result.language,
      // A project with words on it is being edited, not a blank draft. It
      // is not touched if a render already finished -- re-transcribing a
      // finished reel should not un-finish it.
      ...(project.status === "ready" || project.status === "published"
        ? {}
        : { status: "editing" as const }),
    });
    await updateJob(job.id, {
      status: "done",
      progress: 1,
      message: provider.simulated
        ? "Simulated transcript. No speech recognition has run on this footage."
        : "Transcribed " + result.words.length + " words.",
      finishedAt: finishedAt(),
    });
    return;
  }

  if (job.kind === "dub") {
    const transcript = await findTranscript(job.accountId, project.id);
    const language = job.language;
    if (!language) {
      await updateJob(job.id, {
        status: "failed",
        progress: null,
        message: "This dub job has no target language.",
        finishedAt: finishedAt(),
      });
      return;
    }
    await provider.dub(
      {
        projectId: project.id,
        sourcePath,
        language,
        lipSync: job.lipSync ?? false,
        seconds: project.seconds,
        words: transcript?.words ?? [],
      },
      report,
    );
    const dubbedInto = project.dubbedInto.includes(language)
      ? project.dubbedInto
      : [...project.dubbedInto, language];
    await updateProject(project.id, { dubbedInto });
    await updateJob(job.id, {
      status: "done",
      progress: 1,
      message: provider.simulated
        ? "Simulated dub. No audio was generated."
        : "Dubbed into " + language + ".",
      finishedAt: finishedAt(),
    });
    return;
  }

  const result = await provider.render(
    {
      projectId: project.id,
      sourcePath,
      seconds: project.seconds,
      burnSubtitles: project.hasSubtitles,
    },
    report,
  );
  await updateProject(project.id, {
    status: "ready",
    videoUrl: result.videoUrl,
    thumbnailUrl: result.thumbnailUrl,
  });
  await updateJob(job.id, {
    status: "done",
    progress: 1,
    message: provider.simulated
      ? "Simulated render. No video file was written; the URL is a placeholder."
      : "Render complete.",
    finishedAt: finishedAt(),
  });
}

/**
 * Start the in-process worker.
 *
 * One job at a time, on purpose. Concurrency here buys nothing while the
 * only provider is a `setTimeout`, and it would hide the race that
 * `claimNextQueuedJob` exists to prevent until the day a real provider
 * made it slow enough to matter.
 */
export function startJobWorker(options: {
  log?: (message: string) => void;
  provider?: Provider | null;
  pollMs?: number;
} = {}): JobWorker {
  const log = options.log ?? ((message: string) => console.log("[worker] " + message));
  const provider = options.provider === undefined ? resolveProvider() : options.provider;
  const pollMs = options.pollMs ?? env.STUDIO_WORKER_POLL_MS;

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let cycle: Promise<void> = recoverStaleJobs(log).catch((error: unknown) => {
    log("startup recovery failed: " + String(error));
  });

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const job = await claimNextQueuedJob();
    if (!job) return;

    if (!provider) {
      await updateJob(job.id, {
        status: "failed",
        progress: null,
        message:
          "No processing provider is configured on this server, so this job " +
          "cannot run. Set STUDIO_SIMULATE_JOBS=true for a simulated result.",
        finishedAt: new Date().toISOString(),
      });
      return;
    }

    if (job.kind === "render") {
      await updateProject(job.projectId, { status: "rendering" });
    }

    try {
      await runJob(job, provider);
    } catch (error: unknown) {
      // A provider's message is shown to the customer, so it is kept; an
      // unexpected throw is not, because it may carry a stack or a URL
      // with a key in it.
      const message =
        error instanceof Error && error.message
          ? error.message
          : "This job failed for a reason the server could not describe.";
      await updateJob(job.id, {
        status: "failed",
        progress: null,
        message,
        finishedAt: new Date().toISOString(),
      });
      if (job.kind === "render") {
        await updateProject(job.projectId, { status: "failed" });
      }
      log("job " + job.id + " (" + job.kind + ") failed: " + message);
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      cycle = cycle
        .then(tick)
        .catch((error: unknown) => {
          log("tick failed: " + String(error));
        })
        .finally(schedule);
    }, pollMs);
    // So a `stop()` that never comes -- a test that forgets, a script that
    // exits -- does not hold the process open.
    timer.unref?.();
  };

  log(
    provider
      ? "started, provider=" + provider.name + (provider.simulated ? " (SIMULATED)" : "")
      : "started with no provider; queued jobs will be failed with a message",
  );
  schedule();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      // Awaited so a job half-way through its writes finishes them before
      // the process goes. Otherwise a test's temp directory is deleted
      // underneath a pending write.
      await cycle.catch(() => undefined);
      await flushWrites();
    },
  };
}
