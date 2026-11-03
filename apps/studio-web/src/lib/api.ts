/**
 * The contract between this app and `apps/studio-api`.
 *
 * Every type here is the shape of a real endpoint. The client is a thin
 * wrapper around fetch with three deliberate behaviours:
 *
 *   1. **A failed request throws an `ApiError` carrying the server's own
 *      message.** A screen that renders "Something went wrong" when the
 *      server said "that email is already registered" is worse than no
 *      error handling at all.
 *   2. **Identical in-flight mutations are collapsed.** Tapping a button
 *      three times must not create three projects. This repo has already
 *      shipped that bug once, in the clinic portal, where three taps on
 *      Dispense decremented stock three times -- so the guard lives in the
 *      client, where it covers every call site including ones nobody has
 *      written yet.
 *   3. **The token lives in memory and in localStorage**, read once at
 *      boot. localStorage can throw in a private window, so every access
 *      is guarded and a failure means "signed out", not a crash.
 */

import type {
  PlanProblem,
  PlanStyle,
  ScenePlan,
} from '../../../studio/src/lib/scenes.js';

import type { Catalogue } from '../../../studio/src/lib/catalogue.js';
import type { InsightsReport } from '../../../studio/src/lib/insights.js';
export type { InsightsReport };

export type { PlanProblem, PlanStyle, ScenePlan };

/**
 * Where the API is. Empty in development and wherever the API is served on
 * the site's own domain (requests go to `/api` and the dev server or nginx
 * forwards them). Set `VITE_API_URL` at build time when it lives elsewhere --
 * the site on Vercel, the API at https://api.nayaverse.studio -- and the API
 * must then list the site in its `CORS_ORIGINS`.
 */
const API_ORIGIN = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');
const BASE = `${API_ORIGIN}/api`;
const TOKEN_KEY = 'studio.token';

/** A file the API serves by path (a thumbnail, a render), as a full URL. */
export const apiAsset = (url: string): string => (url.startsWith('/') ? API_ORIGIN + url : url);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ---------------------------------------------------------------------------
// Token handling.

let token: string | null = readToken();

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(next: string | null): void {
  token = next;
  try {
    if (next) localStorage.setItem(TOKEN_KEY, next);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* a private window still works for this session */
  }
}

export const hasToken = (): boolean => token !== null;

// ---------------------------------------------------------------------------
// Types. These mirror the API exactly.

export interface Account {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  /** Null until a plan is chosen, which is what gates the dashboard. */
  readonly planId: 'starter' | 'creator' | 'studio' | null;
  readonly region: 'IN' | 'WORLD';
  readonly createdAt: string;
  /** End of the period paid for, when payments are on; null otherwise. */
  readonly paidThrough: string | null;
}

export interface Payment {
  readonly id: string;
  readonly planId: 'starter' | 'creator' | 'studio';
  /** Tax included. */
  readonly amount: number;
  readonly subtotal: number;
  readonly tax: number;
  /** ISO 4217. */
  readonly currency: string;
  readonly status: 'created' | 'paid' | 'failed' | 'expired';
  readonly mode: 'sandbox' | 'production';
  readonly createdAt: string;
  readonly paidAt: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
}

export interface BillingState {
  /** Null when this server takes no payment (test mode). */
  readonly provider: { name: 'cashfree'; mode: 'sandbox' | 'production'; currencies: string[] } | null;
  readonly paidThrough: string | null;
  readonly payments: Payment[];
}

export interface Checkout {
  readonly payment: Payment;
  readonly paymentSessionId: string;
  readonly mode: 'sandbox' | 'production';
  readonly quote: {
    readonly subtotal: number;
    readonly tax: number;
    readonly taxName: string | null;
    readonly amount: number;
    readonly currency: string;
  };
}

export type SocialPlatform = 'instagram' | 'youtube' | 'tiktok';

export interface PlatformInfo {
  readonly id: SocialPlatform;
  readonly name: string;
  /** False when this server has no developer app for it yet. */
  readonly configured: boolean;
  readonly connection: {
    readonly handle: string;
    readonly displayName: string;
    readonly avatar: string | null;
    readonly followers: number | null;
    readonly connectedAt: string;
    readonly lastSyncedAt: string | null;
    readonly lastError: string | null;
    readonly posts: number;
  } | null;
}

export interface Idea {
  readonly title: string;
  readonly hook: string;
  readonly angle: string;
  readonly why: string;
  readonly script: string;
}

export interface IdeasResult {
  readonly ideas: Idea[];
  readonly source: 'model' | 'rules';
  readonly model: string | null;
  readonly note?: string;
}

export type Tone = 'friendly' | 'expert' | 'bold' | 'story';
export type Goal = 'educate' | 'sell' | 'entertain';

export interface WizardBrief {
  readonly topic: string;
  readonly audience?: string;
  readonly language: string;
  readonly tone: Tone;
  readonly goal: Goal;
  readonly seconds: number;
}

export interface SceneDraft {
  readonly text: string;
  readonly visual: string;
}

export interface ScriptDraft {
  readonly title: string;
  readonly scenes: SceneDraft[];
  readonly cta: string | null;
  readonly seconds: number;
  readonly problems: { readonly detail: string; readonly blocking: boolean }[];
  /** How this version keeps a viewer to the end, in the writer's words. */
  readonly why?: string;
}

/** A clip being made, or made, by the AI video service. */
export interface VideoClip {
  readonly id: string;
  readonly status: 'running' | 'ready' | 'failed';
  readonly seconds: number;
  readonly prompt: string;
  readonly message: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

export interface Usage {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly reelsUsed: number;
  readonly reelsIncluded: number;
  readonly dubSecondsUsed: number;
  readonly dubSecondsIncluded: number;
  /** Beyond the included allowance, in the account's own currency. */
  readonly overageDue: number;
}

export type ProjectStatus = 'draft' | 'editing' | 'rendering' | 'ready' | 'published' | 'failed';

export interface Project {
  readonly id: string;
  readonly title: string;
  readonly status: ProjectStatus;
  readonly language: string;
  readonly seconds: number;
  readonly updatedAt: string;
  readonly thumbnailUrl: string | null;
  /** Present once a render has produced something. */
  readonly videoUrl: string | null;
  readonly hasSubtitles: boolean;
  readonly dubbedInto: readonly string[];
}

export type JobKind = 'transcribe' | 'dub' | 'render';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

interface JobBase {
  readonly id: string;
  readonly projectId: string;
  readonly status: JobStatus;
  /** 0..1, or null when the worker cannot report it. */
  readonly progress: number | null;
  readonly message: string | null;
  readonly createdAt: string;
}

/**
 * A job, with `language` only where it means something.
 *
 * The API sends a language on dub jobs only -- a transcribe job's stored
 * language is a hint, not a result, and `toJob` leaves it out. The type
 * used to say "only set on dub" in a comment while allowing it on every
 * kind; as a union, reading it off a transcribe job is a compile error
 * instead of a quiet `undefined`.
 */
export type Job =
  | (JobBase & { readonly kind: 'dub'; readonly language?: string })
  | (JobBase & { readonly kind: Exclude<JobKind, 'dub'> });

/** One spoken word with its timing. The unit auto-subtitles are built from. */
export interface Word {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  /** 0..1 from the recogniser. Low confidence is shown, not hidden. */
  readonly confidence: number;
}

export interface Transcript {
  readonly projectId: string;
  readonly language: string;
  readonly words: readonly Word[];
  /** What the recogniser thought the language was, when asked to detect. */
  readonly detectedLanguage: string | null;
}

export interface SignUpResult {
  readonly token: string;
  readonly account: Account;
}

/**
 * What the Director can do on this server.
 *
 * Read before the panel renders, so a deployment with no model key shows
 * "write it for me" as unavailable up front instead of as a button that
 * fails. `style` is the budget every plan is judged by -- the editor shows
 * it rather than restating it.
 */
export interface AiStatus {
  readonly cut: boolean;
  readonly write: boolean;
  readonly model: string | null;
  readonly style: PlanStyle;
}

export type PlanMode = 'cut' | 'tighten' | 'write';

/** The scene types are the engine's own, so the two sides cannot drift. */
export interface PlanResult {
  readonly plan: ScenePlan;
  readonly problems: readonly PlanProblem[];
  readonly renderable: boolean;
  readonly source: 'rules' | 'model';
  readonly model: string | null;
  readonly attempts: number;
}

// ---------------------------------------------------------------------------
// The client.

/** In-flight mutations, keyed by method, path and body. See note 2 above. */
const inFlight = new Map<string, Promise<unknown>>();

interface Options {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Multipart upload. Mutually exclusive with `body`. */
  form?: FormData;
  signal?: AbortSignal;
}

async function request<T>(path: string, opts: Options = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const key = `${method} ${path} ${opts.body ? JSON.stringify(opts.body) : ''}`;
  // GETs are never collapsed: a refresh button that serves a stale answer
  // is a bug, and two identical GETs are harmless anyway.
  const collapsible = method !== 'GET' && !opts.form;
  if (collapsible) {
    const existing = inFlight.get(key);
    if (existing) return existing as Promise<T>;
  }

  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const run = (async (): Promise<T> => {
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    if (opts.form) init.body = opts.form;
    if (opts.signal) init.signal = opts.signal;

    const res = await fetch(`${BASE}${path}`, init);
    if (res.status === 204) return undefined as T;

    const text = await res.text();
    const data: unknown = text ? safeJson(text) : null;

    if (!res.ok) {
      const shape = data as { error?: string; message?: string; field?: string } | null;
      const message =
        shape?.error ??
        shape?.message ??
        (res.status === 401
          ? 'Your session has expired. Sign in again.'
          : `The server returned ${res.status}.`);
      // A 401 means the token is no longer good; holding onto it just makes
      // every later call fail the same way.
      if (res.status === 401) setToken(null);
      throw new ApiError(res.status, message, shape?.field);
    }
    return data as T;
  })();

  if (collapsible) {
    inFlight.set(key, run);
    // Dropped the moment it settles, so a deliberate second save a second
    // later still goes through. Nothing is cached. `then(drop, drop)`, not
    // `finally`: `finally` returns a second promise that rejects with the
    // request, and nobody holds it, so every failed mutation also raised an
    // unhandled rejection on top of the error its caller had dealt with.
    const drop = () => inFlight.delete(key);
    run.then(drop, drop);
  }
  return run;
}

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 200) };
  }
};

export const api = {
  signUp: (body: { email: string; password: string; name: string; region: 'IN' | 'WORLD' }) =>
    request<SignUpResult>('/auth/signup', { method: 'POST', body }),

  logIn: (body: { email: string; password: string }) =>
    request<SignUpResult>('/auth/login', { method: 'POST', body }),

  me: () => request<Account>('/auth/me'),

  /**
   * Sign out, and actually revoke the token.
   *
   * The order here is the whole point, and it was wrong once. Clearing the
   * token first looks harmless -- the local session is gone either way --
   * but `request` builds its Authorization header from that same variable,
   * so the logout arrived with no header, the server had no token id to
   * revoke, and a token lifted off a shared machine stayed valid for its
   * full twelve hours. Exactly the front-desk machine this repo already
   * worries about elsewhere.
   *
   * So: tell the server while we can still prove who we are, then forget.
   * The local token is cleared even if the request fails, because a user
   * who pressed Sign out must end up signed out of this browser whatever
   * the network did.
   */
  logOut: async () => {
    try {
      await request<void>('/auth/logout', { method: 'POST' });
    } catch {
      /* revoked or unreachable; the local clear below still has to happen */
    } finally {
      setToken(null);
    }
  },

  choosePlan: (planId: 'starter' | 'creator' | 'studio') =>
    request<Account>('/account/plan', { method: 'POST', body: { planId } }),

  usage: () => request<Usage>('/account/usage'),

  billing: () => request<BillingState>('/billing'),

  aiUsage: () => request<{ used: number; limit: number }>('/ai/usage'),
  aiHooks: (brief: WizardBrief) =>
    request<{ hooks: { text: string; angle: string }[]; model: string }>('/ai/hooks', { method: 'POST', body: brief }),
  aiScripts: (brief: WizardBrief, hook: string) =>
    request<{ versions: ScriptDraft[]; model: string }>('/ai/scripts', { method: 'POST', body: { ...brief, hook } }),
  aiRewrite: (brief: WizardBrief, scenes: SceneDraft[], index: number, instruction: string) =>
    request<{ scene: SceneDraft }>('/ai/rewrite', { method: 'POST', body: { ...brief, scenes, index, instruction } }),
  /** A reel's saved edit and its revision; `doc` is null before the first save. */
  getEdit: (projectId: string) => request<{ revision: number; savedAt: string | null; doc: unknown }>(`/projects/${projectId}/edit`),
  saveEdit: (projectId: string, baseRevision: number, doc: unknown) =>
    request<{ revision: number; savedAt: string }>(`/projects/${projectId}/edit`, { method: 'PUT', body: { baseRevision, doc } }),
  /**
   * The last save, as the tab closes. `keepalive` lets it outlive the page,
   * within the browser's 64KB allowance for such requests; a bigger edit
   * was already saved a second after its last change.
   */
  saveEditOnLeave: (projectId: string, baseRevision: number, doc: unknown): boolean => {
    const body = JSON.stringify({ baseRevision, doc });
    if (body.length > 60_000) return false;
    void fetch(`${BASE}/projects/${projectId}/edit`, {
      method: 'PUT',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body,
    }).catch(() => undefined);
    return true;
  },
  /** AI video: what the plan allows this month, and whether the server can make any. */
  videoAllowance: () => request<{ used: number; limit: number; configured: boolean; durations: number[] }>('/ai/video/allowance'),
  shotPrompt: (body: { line: string; visual?: string; topic?: string }) =>
    request<{ prompt: string }>('/ai/shot-prompt', { method: 'POST', body }),
  startVideo: (body: { prompt: string; seconds: number; image?: string | null }) =>
    request<VideoClip>('/ai/video', { method: 'POST', body }),
  videoStatus: (id: string) => request<VideoClip>(`/ai/video/${id}`),
  /** The finished clip's bytes, for the media bin. */
  videoFile: async (id: string): Promise<Blob> => {
    const res = await fetch(`${BASE}/ai/video/${id}/file`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new ApiError(res.status, 'The clip could not be downloaded.');
    return res.blob();
  },
  /** The editor's pass, judgement half: one look and the lines worth a push in. */
  aiEditNotes: (scenes: { id: string; text: string; kind: 'clip' | 'photo' | 'solid'; seconds: number }[], language: string) =>
    request<{ look: 'natural' | 'warm' | 'cool' | 'punchy' | 'mono'; lookReason: string; emphasis: { id: string; reason: string }[]; model: string }>(
      '/ai/edit-notes',
      { method: 'POST', body: { scenes, language } },
    ),

  connections: () => request<{ platforms: PlatformInfo[] }>('/connections'),
  startConnection: (platform: SocialPlatform) =>
    request<{ url: string }>(`/connections/${platform}/start`, { method: 'POST' }),
  syncConnection: (platform: SocialPlatform) =>
    request<NonNullable<PlatformInfo['connection']>>(`/connections/${platform}/sync`, { method: 'POST' }),
  disconnect: (platform: SocialPlatform) => request<{ ok: true }>(`/connections/${platform}`, { method: 'DELETE' }),
  insights: (platform: SocialPlatform | 'all' = 'all') =>
    request<{ report: InsightsReport; connected: number }>(`/insights?platform=${platform}`),
  ideas: (body: { niche: string; audience?: string; language: string; platform?: SocialPlatform | 'all' }) =>
    request<IdeasResult>('/ideas', { method: 'POST', body }),

  checkout: (body: { planId: 'starter' | 'creator' | 'studio'; phone: string }) =>
    request<Checkout>('/billing/checkout', { method: 'POST', body }),

  confirmPayment: (paymentId: string) =>
    request<{ payment: Payment; account: Account }>('/billing/confirm', { method: 'POST', body: { paymentId } }),

  projects: () => request<Project[]>('/projects'),
  project: (id: string) => request<Project>(`/projects/${id}`),
  createProject: (body: { title: string; language: string }) =>
    request<Project>('/projects', { method: 'POST', body }),
  deleteProject: (id: string) => request<void>(`/projects/${id}`, { method: 'DELETE' }),

  uploadFootage: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<Project>(`/projects/${id}/footage`, { method: 'POST', form });
  },

  /** Kick off speech recognition. Poll `jobs` for the result. */
  transcribe: (id: string, body: { language: string | null }) =>
    request<Job>(`/projects/${id}/transcribe`, { method: 'POST', body }),

  transcript: (id: string) => request<Transcript>(`/projects/${id}/transcript`),

  /** Dub into one language. Metered, so the caller shows the cost first. */
  dub: (id: string, body: { language: string; lipSync: boolean }) =>
    request<Job>(`/projects/${id}/dub`, { method: 'POST', body }),

  render: (id: string) => request<Job>(`/projects/${id}/render`, { method: 'POST' }),

  jobs: (projectId?: string) =>
    request<Job[]>(projectId ? `/jobs?projectId=${encodeURIComponent(projectId)}` : '/jobs'),

  /** Plans, prices and languages. Public: no session needed. */
  catalogue: () => request<Catalogue>('/catalogue'),

  aiStatus: () => request<AiStatus>('/ai/status'),

  /**
   * Ask the Director for a scene plan.
   *
   * `library` is the creator's file names, which a model uses to choose
   * visuals that match footage they actually have. Names only: nothing
   * else about the files leaves the browser.
   */
  plan: (body: {
    mode: PlanMode;
    text: string;
    language?: string;
    audience?: string;
    library?: readonly string[];
  }) => request<PlanResult>('/ai/plan', { method: 'POST', body }),
};
