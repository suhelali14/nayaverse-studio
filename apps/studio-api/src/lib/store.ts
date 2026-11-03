import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { env } from "../config/env.js";
import type { PlanId, Region } from "../config/plans.js";
import type { Platform as SocialPlatform, SocialPost as SocialPostShape } from "../../../studio/src/lib/insights.js";

/**
 * Everything this API persists, as one JSON file on disk.
 *
 * ── This is a file store on purpose ──────────────────────────────────
 *
 * `apps/clinic-api`, the template this app otherwise follows, uses Prisma
 * against Postgres. This one does not, for three reasons, in order of
 * weight:
 *
 *   1. **There is no database provisioned for Studio yet.** A Prisma
 *      schema that has never had `migrate` run against it is not
 *      persistence, it is a plan for persistence. Writing one here would
 *      have produced an API that cannot be started or tested by anyone,
 *      including the person reading this.
 *   2. **The product already does this.** `apps/studio/src/lib/store.ts`
 *      keeps every drafted post as a JSON file per post, deliberately, so
 *      that the thing a user most wants to do with a draft -- open it,
 *      fix a word, approve it -- needs no tooling. This store is the same
 *      bet made once more.
 *   3. It keeps the interesting part of this app -- the contract, the
 *      ownership checks, the plan enforcement, the job model -- testable
 *      end to end in one process with no services running.
 *
 * ── What it is NOT ──────────────────────────────────────────────────
 *
 * The whole file is held in memory after the first read and rewritten on
 * every mutation. That is fine for one process and wrong for two: a second
 * instance would not see the first one's writes, and the last writer would
 * silently flatten the other's. **This store is correct only while exactly
 * one process owns the directory.** That is the loudest reason it has to
 * become Postgres before this API runs behind more than one container, and
 * it is a sharper limit than the file size ever will be.
 *
 * ── Moving to Postgres ──────────────────────────────────────────────
 *
 * Deliberately shaped so that the move is one file. Every record below is
 * flat and already has a primary key and, where it belongs to someone, an
 * `accountId` foreign key; there are no nested documents and no arrays
 * doing the work of a join table. To move:
 *
 *   1. Translate the five record interfaces below into a Prisma schema.
 *      `Db.revokedTokens` becomes a `RevokedToken` table keyed by `jti`
 *      with an `expiresAt`; everything else is already a table.
 *   2. Reimplement the exported functions at the bottom of this file --
 *      and only those -- against `prisma`, copying
 *      `apps/clinic-api/src/lib/prisma.ts` for the client singleton.
 *      They are already `async`, already the full surface the routes use,
 *      and no route imports `node:fs`, so nothing outside this file has to
 *      change.
 *   3. Delete `withWriteLock` and `persist`: a transaction replaces both.
 *      `claimNextQueuedJob` becomes `SELECT ... FOR UPDATE SKIP LOCKED`,
 *      which is also what finally makes more than one worker safe.
 *   4. Add indexes on `Project.accountId`, `Job.accountId`,
 *      `Job.status` and `UsageEntry.(accountId, at)`. Those are exactly
 *      the four lookups the functions below do by scanning.
 */

// ---------------------------------------------------------------------------
// Records. The stored shape, which is deliberately wider than the client
// contract in `apps/studio-web/src/lib/api.ts` -- see `lib/mappers.ts` for
// the narrowing, which is the only thing a route is allowed to return.

export interface AccountRecord {
  readonly id: string;
  /** Always trimmed and lower-cased. The normalisation happens once, in
   *  `normaliseEmail`, and the uniqueness check depends on it. */
  readonly email: string;
  readonly name: string;
  /** bcrypt. Never leaves this process -- see `toAccount`. */
  readonly passwordHash: string;
  planId: PlanId | null;
  readonly region: Region;
  readonly createdAt: string;
  /** When a plan was first chosen. Reported, not used for the period
   *  anchor: see `billingPeriod`. */
  planChosenAt: string | null;
  /**
   * The end of the last period paid for, when payments are on. Optional
   * because records written before payments existed do not have it.
   */
  paidThrough?: string | null;
}

/**
 * One attempt to pay for one period of one plan.
 *
 * `id` is also the order id sent to the gateway, so a webhook or a return
 * from checkout names this record directly.
 */
export interface PaymentRecord {
  readonly id: string;
  readonly accountId: string;
  readonly planId: PlanId;
  readonly region: Region;
  /** What the customer pays, tax included. */
  readonly amount: number;
  /** Plan price before tax, kept for the receipt line. */
  readonly subtotal: number;
  readonly tax: number;
  readonly currency: string;
  readonly provider: "cashfree";
  readonly mode: "sandbox" | "production";
  providerOrderId: string | null;
  status: "created" | "paid" | "failed" | "expired";
  readonly createdAt: string;
  paidAt: string | null;
  /** The period this payment bought, set when it is paid. */
  periodStart: string | null;
  periodEnd: string | null;
}

export type ProjectStatus =
  | "draft"
  | "editing"
  | "rendering"
  | "ready"
  | "published"
  | "failed";

export interface FootageRecord {
  /** Our name, never the client's. See `lib/uploads.ts`. */
  readonly storedName: string;
  readonly bytes: number;
  readonly mimetype: string;
  readonly uploadedAt: string;
}

export interface ProjectRecord {
  readonly id: string;
  readonly accountId: string;
  title: string;
  status: ProjectStatus;
  language: string;
  /** Duration of the footage. See `secondsSource` -- this is billable and
   *  is currently not measured server-side. */
  seconds: number;
  /**
   * How we know `seconds`.
   *
   * `client` means the browser told us, which is spoofable and therefore
   * cannot be trusted for money. `probe` means a server-side measurement,
   * which is what `Provider.probe` is for and does not exist yet. Stored
   * so that an audit of dub billing can tell the two apart afterwards
   * rather than guessing.
   */
  secondsSource: "unknown" | "client" | "probe";
  readonly createdAt: string;
  updatedAt: string;
  thumbnailUrl: string | null;
  videoUrl: string | null;
  hasSubtitles: boolean;
  dubbedInto: string[];
  footage: FootageRecord | null;
}

export type JobKind = "transcribe" | "dub" | "render";
export type JobStatus = "queued" | "running" | "done" | "failed";

export interface JobRecord {
  readonly id: string;
  readonly accountId: string;
  readonly projectId: string;
  readonly kind: JobKind;
  status: JobStatus;
  /** 0..1, or null when the worker cannot report it. */
  progress: number | null;
  message: string | null;
  readonly createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Only set on `dub`. */
  readonly language?: string;
  readonly lipSync?: boolean;
  /**
   * Whether the simulator produced this, rather than a real provider.
   *
   * The client contract does not read it yet. It is stored anyway because
   * a simulated result that looks real in the database is a trap: six
   * months from now, with a real provider wired in, the only way to tell
   * which of these transcripts were invented is a flag written at the
   * time. Also reported on the wire, so a UI can say so too.
   */
  readonly simulated: boolean;
}

export interface WordRecord {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly confidence: number;
}

export interface TranscriptRecord {
  readonly projectId: string;
  readonly accountId: string;
  readonly language: string;
  readonly detectedLanguage: string | null;
  readonly words: WordRecord[];
  readonly createdAt: string;
  /** Same reasoning as `JobRecord.simulated`. */
  readonly simulated: boolean;
}

/**
 * One billable event, append-only.
 *
 * Usage is counted from this and never from the live rows, because the
 * obvious implementation -- count the account's projects -- lets anyone
 * reset their own monthly cap by deleting a project. Deleting a project
 * deletes the project; it does not un-spend the reel.
 */
export interface UsageEntry {
  readonly id: string;
  readonly accountId: string;
  readonly kind: "reel" | "dub";
  readonly at: string;
  readonly projectId: string;
  /** Seconds of video dubbed. Only on `dub`. */
  readonly seconds?: number;
  readonly language?: string;
}

/**
 * A connected social account. Tokens are stored sealed (AES-256-GCM, see
 * `lib/social.ts`), never in the clear, and never leave this process.
 */
export interface ConnectionRecord {
  readonly accountId: string;
  readonly platform: SocialPlatform;
  externalId: string;
  handle: string;
  displayName: string;
  avatar: string | null;
  followers: number | null;
  accessTokenSealed: string;
  refreshTokenSealed: string | null;
  expiresAt: string | null;
  readonly connectedAt: string;
  lastSyncedAt: string | null;
  lastError: string | null;
}

/**
 * One request to an AI model, append-only. What the daily allowance is
 * counted from, and what an administrator reads to see cost and failures.
 * Holds no prompt text: what a creator wrote stays in their project.
 */
export interface AiUsageRecord {
  readonly id: string;
  readonly accountId: string;
  readonly kind: string;
  readonly model: string;
  readonly ok: boolean;
  readonly status: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly ms: number;
  readonly at: string;
}

/**
 * One AI-generated video clip: asked for, running at the provider, ready
 * (downloaded into our storage, because the provider's link expires within
 * a day or two), or failed. Seconds are counted against the plan from the
 * moment it is asked for: the provider charges for moderated attempts too.
 */
export interface GenerationRecord {
  readonly id: string;
  readonly accountId: string;
  readonly provider: string;
  readonly model: string;
  readonly prompt: string;
  readonly seconds: number;
  readonly status: "running" | "ready" | "failed";
  readonly taskId: string | null;
  /** Stored file name under the upload directory, once ready. */
  readonly file: string | null;
  /** The provider's code, kept for diagnosis; never shown as-is. */
  readonly failureCode: string | null;
  readonly message: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

/**
 * A reel's edit, as the editor left it: the timeline, markers, caption
 * style, the Director's labels and word timings, and the names of the media
 * it uses. Media itself stays on the creator's machine; this is the document
 * that refers to it. `revision` goes up by one on every save, and a save
 * based on an older revision is refused, so two tabs cannot silently
 * overwrite each other.
 */
export interface EditRecord {
  readonly projectId: string;
  readonly accountId: string;
  readonly revision: number;
  readonly doc: unknown;
  readonly bytes: number;
  readonly savedAt: string;
}

/** A post as last synced, owned by the account that connected it. */
export type PostRecord = SocialPostShape & { readonly accountId: string };

interface Db {
  /** Bumped when a shape change needs a migration step on load. */
  version: 1;
  connections: ConnectionRecord[];
  posts: PostRecord[];
  aiUsage: AiUsageRecord[];
  generations: GenerationRecord[];
  edits: EditRecord[];
  accounts: AccountRecord[];
  projects: ProjectRecord[];
  jobs: JobRecord[];
  transcripts: TranscriptRecord[];
  usage: UsageEntry[];
  payments: PaymentRecord[];
  /**
   * Token ids that have been signed out, mapped to the epoch seconds at
   * which they would have expired anyway.
   *
   * Without this, `POST /auth/logout` is theatre: the browser drops its
   * copy and the token keeps working for the rest of its twelve hours.
   * Pruned on write, so it stays proportional to live sessions rather
   * than growing forever.
   */
  revokedTokens: Record<string, number>;
}

const emptyDb = (): Db => ({
  version: 1,
  accounts: [],
  projects: [],
  jobs: [],
  transcripts: [],
  usage: [],
  payments: [],
  connections: [],
  posts: [],
  aiUsage: [],
  generations: [],
  edits: [],
  revokedTokens: {},
});

// ---------------------------------------------------------------------------
// The file, and the one rule about writing to it.

const FILE = join(env.DATA_DIR, "studio.json");

let db: Db | null = null;

function load(): Db {
  if (db) return db;
  mkdirSync(env.DATA_DIR, { recursive: true });
  if (!existsSync(FILE)) {
    db = emptyDb();
    return db;
  }
  const text = readFileSync(FILE, "utf8");
  try {
    // Trusted input: this file is written only by `persist` below. A
    // partial write cannot reach here, because `persist` renames into
    // place. So a parse failure means the file was damaged by something
    // else, and guessing at a repair would lose accounts.
    db = { ...emptyDb(), ...(JSON.parse(text) as Db) };
  } catch (cause) {
    throw new Error(
      "The Studio store at " +
        FILE +
        " is not valid JSON, so it has not been loaded. Nothing has been " +
        "overwritten. Move the file aside to start fresh, or repair it.",
      { cause },
    );
  }
  return db;
}

/**
 * Write the whole store, atomically.
 *
 * To a temp file in the same directory and then renamed over the target.
 * `rename` within one filesystem is atomic on every platform this runs on
 * (and on Windows libuv passes MOVEFILE_REPLACE_EXISTING, so an existing
 * target is overwritten rather than refused). The alternative, writing in
 * place, has a window in which the file on disk is half a JSON document --
 * and the one moment a crash is most likely is during a write.
 *
 * Same directory, not the OS temp dir, so the rename never crosses a
 * filesystem boundary and degrade into a copy.
 *
 * ── Atomic is not the same as permitted ─────────────────────────────────
 *
 * MOVEFILE_REPLACE_EXISTING handles a target that *exists*. It does nothing
 * about a target another process has *open*, and on Windows that is the
 * common case, not the rare one: OneDrive, Defender and the search indexer
 * all open a file moments after it changes. The rename then fails `EPERM`,
 * and this is not hypothetical -- it is how the store silently stopped
 * saving on the machine this was developed on, while every request still
 * answered 200 and the worker logged `tick failed` into a log nobody reads.
 * An account created, a plan chosen, a job finished: all gone on restart.
 *
 * Those handles are held for milliseconds, so the fix is to wait and try
 * again rather than to give up on the write.
 */
const RENAME_ATTEMPTS = 10;
const RENAME_BACKOFF_MS = 20;

/** Codes that mean "someone else is holding it", as opposed to a real fault. */
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Block this thread for `ms`.
 *
 * `persist` is synchronous and runs inside the mutation lock, so there is no
 * event-loop turn to await on. `Atomics.wait` against a throwaway buffer is
 * the only real sleep synchronous Node has. The whole budget is about a
 * second in the worst case, and losing the write is worse.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function persist(next: Db): void {
  const now = Math.floor(Date.now() / 1000);
  for (const [jti, expiresAt] of Object.entries(next.revokedTokens)) {
    // An expired token is already dead on its own signature; keeping its
    // id would make this map grow without limit.
    if (expiresAt <= now) delete next.revokedTokens[jti];
  }
  mkdirSync(env.DATA_DIR, { recursive: true });
  const tmp = FILE + "." + randomUUID() + ".tmp";
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");

  let lastError: unknown;
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
    try {
      renameSync(tmp, FILE);
      return;
    } catch (error) {
      lastError = error;
      // A missing temp file or a full disk will not be fixed by waiting.
      if (!TRANSIENT.has(String((error as { code?: string }).code))) break;
      sleepSync(RENAME_BACKOFF_MS * (attempt + 1));
    }
  }

  // Every attempt failed, so the caller has to hear about it -- a save that
  // reports success and did not happen is the failure mode this whole
  // module is arranged to avoid. Drop the temp file first: it is a complete
  // copy of the store, password hashes included, and leaving one behind per
  // failed write is how two of them came to be sitting in `data/`.
  try {
    rmSync(tmp, { force: true });
  } catch {
    /* nothing further to try, and the original error is the useful one */
  }
  throw lastError ?? new Error("could not replace " + FILE);
}

/**
 * Serialises every mutation through one promise chain.
 *
 * Two requests that both read the store, both change their own copy and
 * both write it back lose one of the two changes -- and with the whole
 * file as the unit of writing, "one of the two changes" means one of the
 * two accounts. Node's single thread does not help: the `await` inside a
 * route is exactly where the other request runs.
 *
 * `.then(fn, fn)` rather than `.then(fn)` so that one failed mutation does
 * not wedge the queue for the life of the process.
 */
let tail: Promise<unknown> = Promise.resolve();

function withWriteLock<T>(mutate: (db: Db) => T): Promise<T> {
  const step = (): T => {
    const current = load();
    const result = mutate(current);
    try {
      persist(current);
    } catch (cause) {
      // `mutate` has already changed the in-memory copy, and the write that
      // was meant to make that permanent did not happen.
      //
      // Leaving the change in memory is the worst of the available
      // outcomes, and not an obvious one: the caller is told the save
      // failed, and then the *next* successful write flushes this change to
      // disk along with its own. A signup reported as failed would quietly
      // exist, so the person retrying is told their address is already
      // registered. A project reported as failed would be created again,
      // and both copies would land -- each one counted against the
      // account's allowance.
      //
      // Dropping the cache makes the next read come from disk, so the
      // failure means exactly what the caller was told it means. A test
      // holds the file open to prove it: see `test/store.test.mts`.
      db = null;
      throw cause;
    }
    return result;
  };
  const run = tail.then(step, step);
  tail = run.catch(() => undefined);
  return run;
}

/** Reads need no lock: the in-memory copy is never half-updated, because
 *  `mutate` above is synchronous from the store's point of view. */
const read = <T>(select: (db: Db) => T): Promise<T> => Promise.resolve(select(load()));

// ---------------------------------------------------------------------------
// Accounts.

/**
 * The one place an email address is normalised.
 *
 * Case and surrounding whitespace are not part of an identity -- someone
 * who signs up as " Asha@Example.com " on a phone keyboard has to be able
 * to sign in as "asha@example.com". Called on both sides of signup and
 * login so that the uniqueness check and the lookup cannot disagree.
 */
export const normaliseEmail = (email: string): string => email.trim().toLowerCase();

export const findAccountByEmail = (email: string): Promise<AccountRecord | null> => {
  const wanted = normaliseEmail(email);
  return read((d) => d.accounts.find((a) => a.email === wanted) ?? null);
};

export const findAccountById = (id: string): Promise<AccountRecord | null> =>
  read((d) => d.accounts.find((a) => a.id === id) ?? null);

export interface NewAccount {
  readonly email: string;
  readonly name: string;
  readonly passwordHash: string;
  readonly region: Region;
}

/**
 * Insert, refusing a duplicate email inside the lock.
 *
 * The check belongs here rather than in the route: two signups for the
 * same address arriving together both pass a check made before the lock,
 * and the second one is then a second account on an address someone else
 * can receive mail at.
 */
export const insertAccount = (input: NewAccount): Promise<AccountRecord | "duplicate"> =>
  withWriteLock((d) => {
    const email = normaliseEmail(input.email);
    if (d.accounts.some((a) => a.email === email)) return "duplicate";
    const account: AccountRecord = {
      id: "acc_" + randomUUID(),
      email,
      name: input.name,
      passwordHash: input.passwordHash,
      planId: null,
      region: input.region,
      createdAt: new Date().toISOString(),
      planChosenAt: null,
    };
    d.accounts.push(account);
    return account;
  });

// ---------------------------------------------------------------------------
// AI usage.

export const appendAiUsage = (record: Omit<AiUsageRecord, "id" | "at">): Promise<AiUsageRecord> =>
  withWriteLock((d) => {
    const entry: AiUsageRecord = { ...record, id: "ai_" + randomUUID(), at: new Date().toISOString() };
    d.aiUsage.push(entry);
    // Bounded: the ledger answers "today" and "this month", not history.
    if (d.aiUsage.length > 50_000) d.aiUsage.splice(0, d.aiUsage.length - 50_000);
    return entry;
  });

export const listAiUsage = (sinceIso: string, accountId?: string): Promise<AiUsageRecord[]> =>
  read((d) => d.aiUsage.filter((u) => u.at >= sinceIso && (accountId === undefined || u.accountId === accountId)));

// ---------------------------------------------------------------------------
// Edits.

export const getEdit = (projectId: string): Promise<EditRecord | null> =>
  read((d) => d.edits.find((e) => e.projectId === projectId) ?? null);

/**
 * Save an edit if it was based on the revision now stored (0 for none yet).
 * Returns the new record, or the stored one with `conflict` when another
 * save got there first.
 */
export const saveEdit = (
  input: { projectId: string; accountId: string; baseRevision: number; doc: unknown; bytes: number },
): Promise<{ ok: true; edit: EditRecord } | { ok: false; current: EditRecord }> =>
  withWriteLock((d) => {
    const i = d.edits.findIndex((e) => e.projectId === input.projectId);
    const current = i === -1 ? null : d.edits[i]!;
    if ((current?.revision ?? 0) !== input.baseRevision) return { ok: false as const, current: current! };
    const edit: EditRecord = {
      projectId: input.projectId,
      accountId: input.accountId,
      revision: (current?.revision ?? 0) + 1,
      doc: input.doc,
      bytes: input.bytes,
      savedAt: new Date().toISOString(),
    };
    if (i === -1) d.edits.push(edit);
    else d.edits[i] = edit;
    return { ok: true as const, edit };
  });

// ---------------------------------------------------------------------------
// Generated video.

export const insertGeneration = (
  record: Omit<GenerationRecord, "id" | "createdAt" | "finishedAt" | "file" | "failureCode" | "message">,
): Promise<GenerationRecord> =>
  withWriteLock((d) => {
    const entry: GenerationRecord = {
      ...record,
      id: "gen_" + randomUUID(),
      file: null,
      failureCode: null,
      message: null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
    };
    d.generations.push(entry);
    return entry;
  });

export const updateGeneration = (
  id: string,
  patch: Partial<Pick<GenerationRecord, "status" | "taskId" | "file" | "failureCode" | "message" | "finishedAt">>,
): Promise<GenerationRecord | null> =>
  withWriteLock((d) => {
    const i = d.generations.findIndex((g) => g.id === id);
    if (i === -1) return null;
    const next = { ...d.generations[i]!, ...patch };
    d.generations[i] = next;
    return next;
  });

export const getGeneration = (id: string): Promise<GenerationRecord | null> =>
  read((d) => d.generations.find((g) => g.id === id) ?? null);

export const listGenerations = (accountId: string, sinceIso: string): Promise<GenerationRecord[]> =>
  read((d) => d.generations.filter((g) => g.accountId === accountId && g.createdAt >= sinceIso));

// ---------------------------------------------------------------------------
// Social connections and their posts.

export const listConnections = (accountId: string): Promise<ConnectionRecord[]> =>
  read((d) => d.connections.filter((c) => c.accountId === accountId));

export const findConnection = (accountId: string, platform: SocialPlatform): Promise<ConnectionRecord | null> =>
  read((d) => d.connections.find((c) => c.accountId === accountId && c.platform === platform) ?? null);

/** One connection per account and platform: connecting again replaces it. */
export const putConnection = (record: ConnectionRecord): Promise<ConnectionRecord> =>
  withWriteLock((d) => {
    d.connections = d.connections.filter((c) => !(c.accountId === record.accountId && c.platform === record.platform));
    d.connections.push(record);
    return record;
  });

export const updateConnection = (
  accountId: string,
  platform: SocialPlatform,
  patch: Partial<Omit<ConnectionRecord, "accountId" | "platform" | "connectedAt">>,
): Promise<ConnectionRecord | null> =>
  withWriteLock((d) => {
    const c = d.connections.find((x) => x.accountId === accountId && x.platform === platform);
    if (!c) return null;
    Object.assign(c, patch);
    return c;
  });

/** Disconnecting removes the tokens and every post synced through them. */
export const deleteConnection = (accountId: string, platform: SocialPlatform): Promise<boolean> =>
  withWriteLock((d) => {
    const before = d.connections.length;
    d.connections = d.connections.filter((c) => !(c.accountId === accountId && c.platform === platform));
    d.posts = d.posts.filter((p) => !(p.accountId === accountId && p.platform === platform));
    return d.connections.length < before;
  });

/** A sync is a snapshot: the platform's current numbers replace the last ones. */
export const replacePosts = (accountId: string, platform: SocialPlatform, posts: readonly SocialPostShape[]): Promise<number> =>
  withWriteLock((d) => {
    d.posts = d.posts.filter((p) => !(p.accountId === accountId && p.platform === platform));
    for (const p of posts) d.posts.push({ ...p, accountId });
    return posts.length;
  });

export const listPosts = (accountId: string, platform?: SocialPlatform): Promise<PostRecord[]> =>
  read((d) => d.posts.filter((p) => p.accountId === accountId && (platform === undefined || p.platform === platform)));

// ---------------------------------------------------------------------------
// Payments.

export const insertPayment = (record: PaymentRecord): Promise<PaymentRecord> =>
  withWriteLock((d) => {
    d.payments.push(record);
    return record;
  });

export const findPayment = (id: string): Promise<PaymentRecord | null> =>
  read((d) => d.payments.find((p) => p.id === id) ?? null);

export const listPayments = (accountId: string): Promise<PaymentRecord[]> =>
  read((d) =>
    d.payments
      .filter((p) => p.accountId === accountId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );

export const setPaymentStatus = (
  id: string,
  status: "failed" | "expired",
): Promise<PaymentRecord | null> =>
  withWriteLock((d) => {
    const payment = d.payments.find((p) => p.id === id);
    if (!payment || payment.status === "paid") return payment ?? null;
    payment.status = status;
    return payment;
  });

/** One calendar month on, clamped to the last day of a short month. */
export function addMonth(iso: string): string {
  const from = new Date(iso);
  const target = new Date(from);
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + 1);
  const days = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(from.getUTCDate(), days));
  return target.toISOString();
}

/**
 * Mark a payment paid and give the account what it bought. Idempotent.
 *
 * The webhook and the browser's confirmation both arrive for the same
 * payment, often within a second of each other; the check-and-set happens
 * inside the lock, so the second one finds the payment already paid and
 * changes nothing. Without that, one payment would buy two periods.
 *
 * The new period starts when the current paid period ends, or now if
 * there is none or it has lapsed -- so paying early extends rather than
 * overlaps.
 */
export const activatePayment = (
  id: string,
  now: Date = new Date(),
): Promise<{ payment: PaymentRecord; account: AccountRecord } | null> =>
  withWriteLock((d) => {
    const payment = d.payments.find((p) => p.id === id);
    if (!payment) return null;
    const account = d.accounts.find((a) => a.id === payment.accountId);
    if (!account) return null;
    if (payment.status === "paid") return { payment, account };

    const nowIso = now.toISOString();
    const current = account.paidThrough ?? null;
    const start = current !== null && current > nowIso ? current : nowIso;
    const end = addMonth(start);
    payment.status = "paid";
    payment.paidAt = nowIso;
    payment.periodStart = start;
    payment.periodEnd = end;
    account.planId = payment.planId;
    account.planChosenAt ??= nowIso;
    account.paidThrough = end;
    return { payment, account };
  });

export const setAccountPlan = (
  accountId: string,
  planId: PlanId,
): Promise<AccountRecord | null> =>
  withWriteLock((d) => {
    const account = d.accounts.find((a) => a.id === accountId);
    if (!account) return null;
    account.planId = planId;
    account.planChosenAt ??= new Date().toISOString();
    return account;
  });

// ---------------------------------------------------------------------------
// Projects.
//
// Every accessor that takes an `accountId` filters on it. That is the
// ownership check, and it lives here rather than in the routes so that a
// route cannot forget it: there is no exported way to fetch a project by id
// alone.

export const listProjects = (accountId: string): Promise<ProjectRecord[]> =>
  read((d) =>
    d.projects
      .filter((p) => p.accountId === accountId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  );

export const findProject = (
  accountId: string,
  projectId: string,
): Promise<ProjectRecord | null> =>
  read(
    (d) => d.projects.find((p) => p.id === projectId && p.accountId === accountId) ?? null,
  );

/**
 * Create a project and spend a reel from the allowance, in one locked step.
 *
 * The two are one act and so they are one function. Done separately --
 * check the count, then create, then record -- a burst of requests all
 * read the same pre-burst count and all pass, which is how an account on
 * fifteen reels ends up with twenty; and the compensating "create it, then
 * delete it if the count was over" leaves a project visible to a
 * concurrent `GET /projects` that is about to vanish.
 *
 * The allowance comes in as a number because the plan table is not this
 * module's business -- see `config/plans.ts`, which is the only place
 * those numbers live.
 */
export const createProjectWithinAllowance = (input: {
  accountId: string;
  title: string;
  language: string;
  periodStart: string;
  periodEnd: string;
  reelsIncluded: number;
}): Promise<{ ok: true; project: ProjectRecord } | { ok: false; used: number }> =>
  withWriteLock((d) => {
    const used = d.usage.filter(
      (u) =>
        u.accountId === input.accountId &&
        u.kind === "reel" &&
        u.at >= input.periodStart &&
        u.at < input.periodEnd,
    ).length;
    if (used >= input.reelsIncluded) return { ok: false as const, used };

    const now = new Date().toISOString();
    const project: ProjectRecord = {
      id: "prj_" + randomUUID(),
      accountId: input.accountId,
      title: input.title,
      status: "draft",
      language: input.language,
      seconds: 0,
      secondsSource: "unknown",
      createdAt: now,
      updatedAt: now,
      thumbnailUrl: null,
      videoUrl: null,
      hasSubtitles: false,
      dubbedInto: [],
      footage: null,
    };
    d.projects.push(project);
    d.usage.push({
      id: "use_" + randomUUID(),
      accountId: input.accountId,
      kind: "reel",
      at: now,
      projectId: project.id,
    });
    return { ok: true as const, project };
  });

/**
 * Patch a project.
 *
 * `accountId` is optional because the worker legitimately has no
 * authenticated account in hand -- it is acting on a job record that
 * already carries ownership. Every call from a route passes it.
 */
export const updateProject = (
  projectId: string,
  patch: Partial<Omit<ProjectRecord, "id" | "accountId" | "createdAt">>,
  accountId?: string,
): Promise<ProjectRecord | null> =>
  withWriteLock((d) => {
    const project = d.projects.find(
      (p) => p.id === projectId && (accountId === undefined || p.accountId === accountId),
    );
    if (!project) return null;
    Object.assign(project, patch);
    project.updatedAt = new Date().toISOString();
    return project;
  });

/**
 * Delete a project and the work attached to it.
 *
 * The usage ledger is left alone deliberately: see `UsageEntry`. Returns
 * the stored footage so the caller can remove the file, which this module
 * does not do -- a store that reaches outside its own file is a store that
 * can delete the wrong thing.
 */
export const deleteProject = (
  accountId: string,
  projectId: string,
): Promise<{ footage: FootageRecord | null } | null> =>
  withWriteLock((d) => {
    const index = d.projects.findIndex(
      (p) => p.id === projectId && p.accountId === accountId,
    );
    if (index === -1) return null;
    const [removed] = d.projects.splice(index, 1);
    d.jobs = d.jobs.filter((j) => j.projectId !== projectId);
    d.transcripts = d.transcripts.filter((t) => t.projectId !== projectId);
    d.edits = d.edits.filter((e) => e.projectId !== projectId);
    return { footage: removed?.footage ?? null };
  });

// ---------------------------------------------------------------------------
// Jobs.

export const insertJob = (input: {
  accountId: string;
  projectId: string;
  kind: JobKind;
  simulated: boolean;
  language?: string;
  lipSync?: boolean;
  message?: string | null;
}): Promise<JobRecord> =>
  withWriteLock((d) => {
    const job: JobRecord = {
      id: "job_" + randomUUID(),
      accountId: input.accountId,
      projectId: input.projectId,
      kind: input.kind,
      status: "queued",
      progress: 0,
      message: input.message ?? null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      simulated: input.simulated,
      ...(input.language === undefined ? {} : { language: input.language }),
      ...(input.lipSync === undefined ? {} : { lipSync: input.lipSync }),
    };
    d.jobs.push(job);
    return job;
  });

export const listJobs = (accountId: string, projectId?: string): Promise<JobRecord[]> =>
  read((d) =>
    d.jobs
      .filter(
        (j) => j.accountId === accountId && (projectId === undefined || j.projectId === projectId),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );

export const updateJob = (
  jobId: string,
  patch: Partial<Pick<JobRecord, "status" | "progress" | "message" | "startedAt" | "finishedAt">>,
): Promise<JobRecord | null> =>
  withWriteLock((d) => {
    const job = d.jobs.find((j) => j.id === jobId);
    if (!job) return null;
    Object.assign(job, patch);
    return job;
  });

/**
 * Take the oldest queued job and mark it running, in one locked step.
 *
 * Read-then-write would let two ticks of the worker pick up the same job
 * and run it twice -- which for a metered operation means charging twice.
 * In Postgres this becomes `FOR UPDATE SKIP LOCKED`.
 */
export const claimNextQueuedJob = (): Promise<JobRecord | null> =>
  withWriteLock((d) => {
    const queued = d.jobs
      .filter((j) => j.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const job = queued[0];
    if (!job) return null;
    job.status = "running";
    job.progress = 0;
    job.startedAt = new Date().toISOString();
    return job;
  });

/** Jobs left `running` by a process that stopped mid-job. */
export const listStaleRunningJobs = (): Promise<JobRecord[]> =>
  read((d) => d.jobs.filter((j) => j.status === "running"));

// ---------------------------------------------------------------------------
// Transcripts.

export const putTranscript = (record: TranscriptRecord): Promise<TranscriptRecord> =>
  withWriteLock((d) => {
    d.transcripts = d.transcripts.filter((t) => t.projectId !== record.projectId);
    d.transcripts.push(record);
    return record;
  });

export const findTranscript = (
  accountId: string,
  projectId: string,
): Promise<TranscriptRecord | null> =>
  read(
    (d) =>
      d.transcripts.find((t) => t.projectId === projectId && t.accountId === accountId) ?? null,
  );

// ---------------------------------------------------------------------------
// Usage ledger.

export const appendUsage = (input: Omit<UsageEntry, "id" | "at">): Promise<UsageEntry> =>
  withWriteLock((d) => {
    const entry: UsageEntry = {
      id: "use_" + randomUUID(),
      at: new Date().toISOString(),
      ...input,
    };
    d.usage.push(entry);
    return entry;
  });

/** Entries in `[fromIso, toIso)`. ISO-8601 UTC strings compare correctly
 *  as strings, which is the one reason every timestamp here is one. */
export const listUsage = (
  accountId: string,
  fromIso: string,
  toIso: string,
): Promise<UsageEntry[]> =>
  read((d) =>
    d.usage.filter((u) => u.accountId === accountId && u.at >= fromIso && u.at < toIso),
  );

// ---------------------------------------------------------------------------
// Signed-out tokens.

export const revokeToken = (jti: string, expiresAtEpochSeconds: number): Promise<void> =>
  withWriteLock((d) => {
    d.revokedTokens[jti] = expiresAtEpochSeconds;
  });

export const isTokenRevoked = (jti: string): Promise<boolean> =>
  read((d) => Object.prototype.hasOwnProperty.call(d.revokedTokens, jti));

// ---------------------------------------------------------------------------
// For tests only.

/** The file this store is backed by, so a test can assert on it. */
export const storeFile = (): string => FILE;

/**
 * Drop the in-memory copy so the next access re-reads from disk.
 *
 * Exists for the test that proves a write actually reached the file rather
 * than only the heap. Not used by the running app, which has no reason to
 * forget what it knows.
 */
export const forgetCachedStore = async (): Promise<void> => {
  await tail;
  db = null;
};

/** Resolves when every queued mutation has been written. */
export const flushWrites = async (): Promise<void> => {
  await tail;
};
