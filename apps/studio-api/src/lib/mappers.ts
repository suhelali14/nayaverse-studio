import type { PlanId, Region } from "../config/plans.js";
import type {
  AccountRecord,
  JobRecord,
  ProjectRecord,
  TranscriptRecord,
  WordRecord,
} from "./store.js";

/**
 * Stored record to wire shape.
 *
 * ── Why this is one file and not a `select` per route ────────────────
 *
 * The rule is that a route returns the output of one of these functions
 * and nothing else. Picking fields at each call site is how
 * `passwordHash` eventually ships: it takes one new endpoint written in a
 * hurry, or one `return account` where a mapper was meant, and the field
 * is on the wire. There is no safe version of "remember not to".
 *
 * So `toAccount` is the only way an account becomes JSON, it lists the
 * fields it allows rather than the ones it strips, and the test suite
 * scans every response body the whole suite produces for `passwordHash`
 * and `password`. An added stored field is invisible until somebody adds
 * it here on purpose.
 *
 * The shapes below mirror `apps/studio-web/src/lib/api.ts` exactly. That
 * file is the contract; these interfaces are a copy of it and are
 * deliberately written out in full rather than loosely typed, so that a
 * field renamed on one side fails to compile on this one.
 */

export interface Account {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly planId: PlanId | null;
  readonly region: Region;
  readonly createdAt: string;
  readonly paidThrough: string | null;
}

export const toAccount = (record: AccountRecord): Account => ({
  id: record.id,
  email: record.email,
  name: record.name,
  planId: record.planId,
  region: record.region,
  createdAt: record.createdAt,
  paidThrough: record.paidThrough ?? null,
});

export interface Project {
  readonly id: string;
  readonly title: string;
  readonly status: ProjectRecord["status"];
  readonly language: string;
  readonly seconds: number;
  readonly updatedAt: string;
  readonly thumbnailUrl: string | null;
  readonly videoUrl: string | null;
  readonly hasSubtitles: boolean;
  readonly dubbedInto: readonly string[];
}

export const toProject = (record: ProjectRecord): Project => ({
  id: record.id,
  title: record.title,
  status: record.status,
  language: record.language,
  seconds: record.seconds,
  updatedAt: record.updatedAt,
  thumbnailUrl: record.thumbnailUrl,
  videoUrl: record.videoUrl,
  hasSubtitles: record.hasSubtitles,
  // Copied, not handed out: the stored array is the live one, and a caller
  // that mutated it would be editing the store from outside.
  dubbedInto: [...record.dubbedInto],
});

export interface Job {
  readonly id: string;
  readonly projectId: string;
  readonly kind: JobRecord["kind"];
  readonly status: JobRecord["status"];
  readonly progress: number | null;
  readonly message: string | null;
  readonly createdAt: string;
  readonly language?: string;
  /**
   * Not in the client contract, and sent anyway.
   *
   * The contract does not read it yet, but a UI that shows a transcript
   * has to be able to say where it came from, and the alternative is a
   * screen that presents an invented transcript as a real one. Additive,
   * so the typed client ignores it until someone wants it.
   */
  readonly simulated: boolean;
}

export const toJob = (record: JobRecord): Job => ({
  id: record.id,
  projectId: record.projectId,
  kind: record.kind,
  status: record.status,
  progress: record.progress,
  message: record.message,
  createdAt: record.createdAt,
  /**
   * Sent on a dub and nothing else.
   *
   * A transcribe job also stores a language -- the hint the caller gave,
   * which the worker needs -- but the contract says of this field "Only
   * set on `dub`", so that is what goes on the wire. The type would have
   * allowed it on all three; a client written against the comment would
   * have been wrong about what a present `language` meant.
   */
  ...(record.kind === "dub" && record.language !== undefined
    ? { language: record.language }
    : {}),
  simulated: record.simulated,
});

export interface Word {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly confidence: number;
}

export interface Transcript {
  readonly projectId: string;
  readonly language: string;
  readonly words: readonly Word[];
  readonly detectedLanguage: string | null;
  /** Same reasoning as `Job.simulated`. */
  readonly simulated: boolean;
}

const toWord = (word: WordRecord): Word => ({
  text: word.text,
  startMs: word.startMs,
  endMs: word.endMs,
  confidence: word.confidence,
});

export const toTranscript = (record: TranscriptRecord): Transcript => ({
  projectId: record.projectId,
  language: record.language,
  words: record.words.map(toWord),
  detectedLanguage: record.detectedLanguage,
  simulated: record.simulated,
});

export interface Usage {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly reelsUsed: number;
  readonly reelsIncluded: number;
  readonly dubSecondsUsed: number;
  readonly dubSecondsIncluded: number;
  readonly overageDue: number;
}
