import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { env } from "./config/env.js";
import { MAX_UPLOAD_BYTES } from "./lib/uploads.js";
import { startJobWorker, type JobWorker, type Provider } from "./lib/worker.js";
import { resolvePlanModel } from "./lib/ai.js";
import { resolveGateway, type PaymentGateway } from "./lib/cashfree.js";
import { setPaymentsRequired } from "./lib/usage.js";
import type { PlanModel } from "../../studio/src/lib/scenes.js";
import authPlugin from "./plugins/auth.js";
import securityPlugin from "./plugins/security.js";
import { adminRoutes } from "./routes/admin.js";
import { writerRoutes } from "./routes/writer.js";
import { resolveWriter, type Writer } from "./lib/writer.js";
import { resolveEditNotes, type EditNotesModel } from "./lib/edit-notes.js";
import { resolveShotPrompter, resolveVideoGenerator, type ShotPrompter, type VideoGenerator } from "./lib/video-gen.js";
import { videoRoutes } from "./routes/video.js";
import { editRoutes } from "./routes/edits.js";
import { accountRoutes } from "./routes/account.js";
import { aiRoutes } from "./routes/ai.js";
import { catalogueRoutes } from "./routes/catalogue.js";
import { authRoutes } from "./routes/auth.js";
import { billingRoutes } from "./routes/billing.js";
import { socialRoutes } from "./routes/social.js";
import { resolveAdapters, type Adapters } from "./lib/social.js";
import { resolveIdeaModel, type IdeaModel } from "./lib/ideas.js";
import { healthRoutes } from "./routes/health.js";
import { jobRoutes } from "./routes/jobs.js";
import { projectRoutes } from "./routes/projects.js";

/**
 * How hard the auth routes are limited, per IP, per minute.
 *
 * Ten rather than the global 300. Signup and login are the only two
 * endpoints where guessing is worth anything, and ten attempts a minute is
 * far beyond honest mistyping while making a password list take years.
 *
 * Note what this does **not** do: it is keyed by IP, so it slows one
 * attacker down and does nothing about a distributed attempt against one
 * account. The per-account lockout that would is a real gap, and it needs
 * a counter that survives a restart -- which is the store, which is a
 * file, which is the thing that has to become Postgres first.
 */
export const AUTH_RATE_LIMIT_PER_MINUTE = 10;

/**
 * How often one IP may ask the Director for a plan, per minute.
 *
 * Every `write` and `tighten` is a paid model call. Twenty a minute is far
 * more than a person iterating on a script produces, and low enough that a
 * stuck retry loop in a client costs cents rather than a bill. `cut` shares
 * the limit because it shares the route; it costs nothing, and twenty cuts
 * a minute is still more than anyone types.
 */
export const AI_PLAN_RATE_LIMIT_PER_MINUTE = 20;

export interface BuildOptions {
  /**
   * Start the in-process job worker. On by default: without it,
   * transcribe/dub/render would accept work and never do it.
   */
  worker?: boolean;
  /** Overridden by tests that want to prove the limiter fires. */
  authRateLimitMax?: number;
  /** Overridden by tests that want to prove the upload cap fires. */
  maxUploadBytes?: number;
  /** Overridden by tests; `null` means "no provider configured". */
  provider?: Provider | null;
  /**
   * The Director's writer. Omitted means "whatever the env configures";
   * `null` means none, which is how tests prove the no-key path.
   */
  planModel?: PlanModel | null;
  aiRateLimitMax?: number;
  /** Overridden by tests with a fake gateway; `null` means test mode. */
  paymentGateway?: PaymentGateway | null;
  /** Overridden by tests with fake platforms. */
  socialAdapters?: Adapters;
  /** Overridden by tests; `null` means ideas come from the rules alone. */
  ideaModel?: IdeaModel | null;
  /** Overridden by tests; `null` means the wizard has no writer. */
  writer?: Writer | null;
  /** Overridden by tests; `null` means the editor's pass has no notes. */
  editNotes?: EditNotesModel | null;
  /** Overridden by tests; `null` means AI video is off (no provider key). */
  videoGenerator?: VideoGenerator | null;
  shotPrompter?: ShotPrompter | null;
  /** How finished clips are downloaded from the provider. Tests replace it. */
  fetcher?: typeof fetch;
  logger?: boolean;
}

export function buildApp(options: BuildOptions = {}): FastifyInstance {
  const proxy = process.env.TRUST_PROXY ?? "";
  const app = Fastify({
    logger: options.logger ?? env.NODE_ENV !== "test",
    // See TRUST_PROXY in config/env.ts: hops of proxy whose X-Forwarded-For is believed.
    trustProxy: /^\d+$/.test(proxy) ? (_address: string, hop: number) => hop < Number(proxy) : proxy === "true",
  });

  /**
   * One error shape out of this API, whatever threw.
   *
   * The client reads `{ error, field? }` and falls back to "The server
   * returned 500" when it gets anything else -- so a route that throws, a
   * plugin that throws a plain object, and the rate limiter all have to
   * arrive here and leave looking the same. This is
   * `apps/clinic-api/src/app.ts`'s handler, with its two hard-won cases
   * kept: a thrown non-Error, and a reply whose status the limiter has
   * already set.
   */
  app.setErrorHandler(
    (error: Error & { code?: string; statusCode?: number }, request, reply) => {
      if (!(error instanceof Error)) {
        const thrown = error as unknown as Record<string, unknown>;
        error = Object.assign(
          new Error(String(thrown?.error ?? thrown?.message ?? "Request failed")),
          { statusCode: typeof thrown?.statusCode === "number" ? thrown.statusCode : undefined },
        );
      }

      // A browser that navigates away mid-upload closes the socket.
      // Nothing failed; the uploader left.
      const aborted =
        error.code === "ERR_STREAM_PREMATURE_CLOSE" ||
        error.message === "Premature close" ||
        request.raw.destroyed;
      if (aborted) {
        request.log.debug({ url: request.url }, "client aborted the request");
        return;
      }

      // The multipart parser's own limit errors are the caller's problem,
      // not ours, and arrive as 413 rather than as a crash.
      const isTooLarge =
        error.code === "FST_REQ_FILE_TOO_LARGE" || error.code === "FST_PARTS_LIMIT";

      const status = isTooLarge
        ? 413
        : (error.statusCode ?? (reply.statusCode >= 400 ? reply.statusCode : 500));

      if (status >= 500) {
        request.log.error({ err: error, url: request.url }, "request failed");
      } else {
        request.log.warn({ err: error.message, url: request.url, status }, "request rejected");
      }

      if (!reply.sent) {
        reply.status(status).send({
          // 4xx messages are actionable and are passed through. 5xx are
          // ours and may carry a path, a stack or a provider URL, so they
          // are made generic.
          error: status >= 500 ? "Something went wrong." : error.message,
        });
      }
    },
  );

  /**
   * CORS: an allowlist in production, anything in development.
   *
   * `origin: true` reflects whatever Origin the browser sent, which means
   * any page a signed-in creator happens to have open could drive this API
   * as them. Development stays permissive so the Vite dev server works on
   * whatever port it lands on.
   */
  app.register(cors, {
    credentials: true,
    origin:
      env.NODE_ENV !== "production"
        ? true
        : (origin: string | undefined, callback: (err: Error | null, allow: boolean) => void) => {
            // Same-origin and server-to-server requests send no Origin.
            if (!origin) return callback(null, true);
            if (env.CORS_ALLOWLIST.includes(origin)) return callback(null, true);
            // Refused by leaving the CORS headers off, not by failing: an
            // error here became a 500 and an error-level log line for every
            // bot that sends an Origin. Without the headers the browser
            // will not let that page read a response or send a preflighted
            // request, and the API's bearer tokens are never sent cross-site.
            callback(null, false);
          },
  });

  app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    // Polled on a timer by whatever is watching this service; throttling
    // it would look like an outage.
    allowList: (request) => request.url === "/health",
    // Must be a real Error carrying `statusCode`. fastify-rate-limit
    // throws whatever this returns, and a plain object reaches the error
    // handler above with no status -- which is how a throttled login came
    // back as a 500 in the clinic API.
    errorResponseBuilder: (_request, context) => {
      const retryIn = Math.ceil((context.ttl ?? 60_000) / 1000);
      const error = new Error(
        "Too many attempts. Try again in " + retryIn + " seconds.",
      ) as Error & { statusCode: number };
      error.statusCode = 429;
      return error;
    },
  });

  /**
   * 200 MB and one file.
   *
   * Enforced by the parser, as a stream limit, so an oversized upload is
   * cut off mid-flight rather than written to disk and measured
   * afterwards. `files: 1` because the one endpoint that takes a file
   * takes one; without it, a request with ten thousand parts is a cheap
   * way to make this process do work.
   */
  app.register(multipart, {
    limits: {
      fileSize: options.maxUploadBytes ?? MAX_UPLOAD_BYTES,
      files: 1,
      // A multipart body that is all field names is still a body someone
      // has to parse.
      fields: 10,
      fieldSize: 1024,
    },
  });

  app.register(authPlugin);
  app.register(securityPlugin);

  app.register(authRoutes, {
    authRateLimitMax: options.authRateLimitMax ?? AUTH_RATE_LIMIT_PER_MINUTE,
  });
  app.register(healthRoutes);
  app.register(catalogueRoutes);
  const gateway = options.paymentGateway === undefined ? resolveGateway() : options.paymentGateway;
  setPaymentsRequired(gateway !== null);
  app.register(accountRoutes, { paymentsOn: gateway !== null });
  app.register(billingRoutes, { gateway });
  app.register(adminRoutes);
  app.register(writerRoutes, {
    writer: options.writer === undefined ? resolveWriter() : options.writer,
    editNotes: options.editNotes === undefined ? resolveEditNotes() : options.editNotes,
  });
  app.register(editRoutes);
  app.register(videoRoutes, {
    generator: options.videoGenerator === undefined ? resolveVideoGenerator() : options.videoGenerator,
    prompter: options.shotPrompter === undefined ? resolveShotPrompter() : options.shotPrompter,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  });
  app.register(socialRoutes, {
    adapters: options.socialAdapters ?? resolveAdapters(),
    ideaModel: options.ideaModel === undefined ? resolveIdeaModel() : options.ideaModel,
    ideasRateLimitMax: 10,
  });
  app.register(aiRoutes, {
    planModel: options.planModel === undefined ? resolvePlanModel() : options.planModel,
    planRateLimitMax: options.aiRateLimitMax ?? AI_PLAN_RATE_LIMIT_PER_MINUTE,
  });
  app.register(projectRoutes);
  app.register(jobRoutes);

  if (options.worker ?? true) {
    const worker: JobWorker = startJobWorker({
      log: (message) => app.log.info("[worker] " + message),
      ...(options.provider === undefined ? {} : { provider: options.provider }),
    });
    // Awaited on close so a job's writes finish before the process (or a
    // test's temp directory) goes away.
    app.addHook("onClose", async () => {
      await worker.stop();
    });
  }

  return app;
}
