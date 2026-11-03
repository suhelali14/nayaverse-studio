import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * This app's root on disk, derived from this module rather than from
 * `process.cwd()`. The API gets started from the repo root (turbo), from
 * its own folder (`npm run dev -w apps/studio-api`) and from the test
 * runner, and all three used to disagree about where `data/` was -- which
 * meant a test run could quietly write into the development store.
 */
const APP_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * A development signing key that is obviously not a secret.
 *
 * The alternative -- a random key per boot -- signs every developer out on
 * every file save, because `tsx watch` restarts the process. The
 * alternative to that is a plausible-looking hard-coded secret, which is
 * how a real one ends up in production by accident. So: constant, named
 * loudly enough that nobody mistakes it for a key, and refused outright in
 * production by the refinement below.
 */
const DEV_JWT_SECRET = "studio-dev-only-insecure-signing-key-do-not-deploy";

const schema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(4300),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    /**
     * Optional here, required in production by the refinement below.
     *
     * 32 characters rather than the clinic API's 16: this key is the only
     * thing between a stranger and every account's unreleased footage, and
     * unlike the clinic API there is no server-side session store to
     * revoke against wholesale if it leaks.
     */
    JWT_SECRET: z
      .string()
      .min(32, "JWT_SECRET must be at least 32 characters -- see .env.example")
      .optional(),

    /** Comma-separated allowlist, enforced in production only. */
    CORS_ORIGINS: z.string().optional(),
    /**
     * Behind a reverse proxy (nginx), how many hops to trust for the
     * client's address. Without it every request appears to come from the
     * proxy, and the per-address limits on sign-in and on requests treat
     * all users as one. "1" for one nginx in front; empty when the API
     * faces the internet directly, where trusting the header would let
     * anyone choose their own address.
     */
    TRUST_PROXY: z.string().regex(/^(\d+|true|false)?$/, "TRUST_PROXY is a number of hops, true or false.").optional(),

    /**
     * Where the JSON store and the uploaded footage live. Overridable so
     * the test suite can point at a throwaway directory, and so a
     * deployment can put both on a mounted volume rather than inside the
     * container filesystem that gets replaced on every deploy.
     */
    STUDIO_DATA_DIR: z.string().optional(),
    STUDIO_UPLOAD_DIR: z.string().optional(),

    /**
     * The simulation switch. Deliberately tri-state: unset means whatever
     * is right for this NODE_ENV, which is on outside production and off
     * inside it. Setting it true in production is allowed -- a staging
     * deployment is a real use -- but it warns at boot, because a
     * production database full of invented transcripts is a trap that
     * takes weeks to notice.
     */
    STUDIO_SIMULATE_JOBS: z.enum(["true", "false"]).optional(),

    /** End-to-end duration of one simulated job. Short in tests. */
    STUDIO_SIMULATE_MS: z.coerce.number().int().min(0).max(600000).default(3000),

    /** How often the in-process worker looks for queued work. */
    STUDIO_WORKER_POLL_MS: z.coerce.number().int().min(5).max(60000).default(250),

    /**
     * Script writing. Optional in every environment, on purpose.
     *
     * Without a key the Director still cuts a script the creator wrote --
     * that path is rules, not a model -- and the routes that need a model
     * answer 503 with a message saying so. A product whose editor stopped
     * working because a billing card expired would be the wrong way round.
     */
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    /** Overrides the light model in `apps/studio/src/lib/scenes.ts`. */
    STUDIO_AI_MODEL: z.string().min(1).optional(),
    /**
     * The model that writes: hooks, scripts, one-scene rewrites and ideas.
     * Defaults to the writer model in `lib/writer.ts`. Writing is where a
     * stronger model shows; cutting a script into scenes stays light.
     */
    STUDIO_WRITER_MODEL: z.string().min(1).optional(),
    /**
     * Runway, for AI-generated video. Billable per second generated, so
     * absent means off: the routes answer 503 and the editor says so.
     */
    RUNWAY_API_KEY: z.string().min(1).optional(),
    /** Runway model id. gen4.5 does text-to-video and image-to-video. */
    RUNWAY_MODEL: z.string().min(1).default("gen4.5"),

    /**
     * Cashfree, for taking payment. Both keys or neither: with neither, the
     * plan chooser records a plan without payment and says it is in test
     * mode, which is what development wants. See `lib/cashfree.ts`.
     */
    CASHFREE_APP_ID: z.string().min(1).optional(),
    CASHFREE_SECRET_KEY: z.string().min(1).optional(),
    CASHFREE_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
    CASHFREE_API_VERSION: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default("2025-01-01"),
    /** Currencies the Cashfree account can actually take. USD needs
     *  international payments switched on in the Cashfree dashboard. */
    CASHFREE_CURRENCIES: z.string().default("INR"),

    /** Where the web app lives, for the address a payment returns to. */
    PUBLIC_WEB_URL: z.string().url().default("http://localhost:5179"),
    /** Where this API is reachable from the internet, for webhooks and
     *  OAuth callbacks. Cashfree only calls https addresses. */
    PUBLIC_API_URL: z.string().url().optional(),

    /**
     * Social accounts, read-only, for Insights and Ideas. Each pair is
     * optional and switches on one platform. See `lib/social.ts`.
     */
    INSTAGRAM_APP_ID: z.string().min(1).optional(),
    INSTAGRAM_APP_SECRET: z.string().min(1).optional(),
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    TIKTOK_CLIENT_KEY: z.string().min(1).optional(),
    TIKTOK_CLIENT_SECRET: z.string().min(1).optional(),
    /**
     * 32 bytes, base64, for encrypting platform tokens at rest. Required in
     * production once any platform is configured; development derives one
     * from JWT_SECRET so a restart keeps connections working.
     */
    TOKEN_ENCRYPTION_KEY: z.string().min(1).optional(),

    /** Comma-separated emails with operator access (lib/access.ts). */
    STUDIO_ADMIN_EMAILS: z.string().default(""),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === "production" && !value.JWT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["JWT_SECRET"],
        message:
          "JWT_SECRET is required in production. Without it every token this " +
          "process issues would be signed with a key published in this repo.",
      });
    }
    if (Boolean(value.CASHFREE_APP_ID) !== Boolean(value.CASHFREE_SECRET_KEY)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CASHFREE_SECRET_KEY"],
        message: "Set both CASHFREE_APP_ID and CASHFREE_SECRET_KEY, or neither.",
      });
    }
    const socialConfigured =
      Boolean(value.INSTAGRAM_APP_ID) || Boolean(value.GOOGLE_CLIENT_ID) || Boolean(value.TIKTOK_CLIENT_KEY);
    if (value.NODE_ENV === "production" && socialConfigured && !value.TOKEN_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TOKEN_ENCRYPTION_KEY"],
        message:
          "TOKEN_ENCRYPTION_KEY is required in production when a social platform is configured, " +
          "or platform tokens would be encrypted with a key derived from a value in this repo.",
      });
    }
    if (value.NODE_ENV === "production" && value.JWT_SECRET === DEV_JWT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["JWT_SECRET"],
        message: "JWT_SECRET is the development placeholder. Generate a real one.",
      });
    }
  });

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Thrown, not logged-and-continued: a process that boots with no signing
  // key is worse than one that does not boot at all.
  const lines = parsed.error.issues.map(
    (issue) => "  " + (issue.path.join(".") || "(env)") + ": " + issue.message,
  );
  throw new Error("Invalid environment for studio-api:\n" + lines.join("\n"));
}

const raw = parsed.data;

const simulateJobs =
  raw.STUDIO_SIMULATE_JOBS !== undefined
    ? raw.STUDIO_SIMULATE_JOBS === "true"
    : raw.NODE_ENV !== "production";

export const env = {
  ...raw,
  JWT_SECRET: raw.JWT_SECRET ?? DEV_JWT_SECRET,
  /** True when JWT_SECRET came from the constant above, so boot can say so. */
  JWT_SECRET_IS_DEV_DEFAULT: raw.JWT_SECRET === undefined,
  DATA_DIR: raw.STUDIO_DATA_DIR ?? APP_ROOT + "data",
  UPLOAD_DIR: raw.STUDIO_UPLOAD_DIR ?? APP_ROOT + "uploads",
  SIMULATE_JOBS: simulateJobs,
  CORS_ALLOWLIST: (raw.CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  ADMIN_EMAIL_LIST: raw.STUDIO_ADMIN_EMAILS.split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
  CASHFREE_CURRENCY_LIST: raw.CASHFREE_CURRENCIES.split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean),
} as const;

export type Env = typeof env;
