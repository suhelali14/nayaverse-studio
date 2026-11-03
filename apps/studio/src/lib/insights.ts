/**
 * What a creator's own posts say about what to make next.
 *
 * Pure functions over posts already fetched from Instagram, YouTube or
 * TikTok and normalised into `SocialPost`. Nothing here calls a network or
 * a model, so every number on the Insights page is reproducible from the
 * posts it was computed from.
 *
 * ── Two rules this module keeps ─────────────────────────────────────
 *
 *  1. **The comparison is always the creator against themselves.** "Posts
 *     with a question in the first line got 1.8x your usual views" is
 *     something their data shows. "Creators in your niche post five times
 *     a week" would be a benchmark this product has no data for, so it is
 *     never said.
 *  2. **Medians, and a minimum sample.** One viral post must not make a
 *     topic look like a strategy, so lifts are median against median and a
 *     pattern needs at least `MIN_GROUP` posts on each side before it is
 *     reported. Thin data says "not enough posts yet", not a guess.
 */

export type Platform = 'instagram' | 'youtube' | 'tiktok';
export type PostFormat = 'reel' | 'short' | 'video' | 'image' | 'carousel';

export interface SocialPost {
  readonly platform: Platform;
  readonly id: string;
  readonly publishedAt: string;
  /** Caption, or title and description joined. */
  readonly caption: string;
  readonly url: string | null;
  readonly thumbnail: string | null;
  readonly format: PostFormat;
  readonly durationSec: number | null;
  /** Plays or views; null where the platform does not report them. */
  readonly views: number | null;
  readonly reach: number | null;
  readonly likes: number;
  readonly comments: number;
  readonly shares: number | null;
  readonly saves: number | null;
}

export const MIN_GROUP = 3;
const DAY_MS = 86_400_000;

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The audience a post reached: views where reported, else reach. */
export const audienceOf = (post: SocialPost): number | null => post.views ?? post.reach;

/** Interactions per view (or per account reached), as a fraction. */
export function engagementOf(post: SocialPost): number | null {
  const base = audienceOf(post);
  if (!base) return null;
  return (post.likes + post.comments + (post.shares ?? 0) + (post.saves ?? 0)) / base;
}

const round = (n: number, places = 2): number => Math.round(n * 10 ** places) / 10 ** places;

// ---------------------------------------------------------------------------
// Reading captions.

const STOPWORDS = new Set(
  (
    'a an and are as at be but by for from has have i if in into is it its just me my of on or our so ' +
    'that the their them then there these they this to too up us was we what when which who why will ' +
    'with you your how can do does did not no yes all any more most very get got make made one two new ' +
    'here now out about like follow link bio comment share save watch video reel shorts subscribe ' +
    'through after before every over under again still also only some many much really today tonight ' +
    'from with into onto than then just been being were would could should'
  ).split(' '),
);

export function hashtagsOf(caption: string): string[] {
  // \p{M} too: without the vowel signs, #मुंबई is cut to #मु.
  const found = caption.match(/#[\p{L}\p{N}\p{M}_]+/gu) ?? [];
  return [...new Set(found.map((t) => t.toLowerCase()))];
}

/** Content words: four letters or more, not a stopword, not a hashtag or handle. */
export function keywordsOf(caption: string): string[] {
  const words = caption
    .replace(/[#@][\p{L}\p{N}\p{M}_]+/gu, ' ')
    .toLowerCase()
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  return [...new Set(words)];
}

/** The opening line, which is what a scroll decides on. */
export function hookOf(caption: string): string {
  const first = caption.trim().split(/\n|(?<=[.!?।])\s/u)[0] ?? '';
  return first.trim();
}

// ---------------------------------------------------------------------------
// The report.

export interface Lift {
  /** The group's label: a hashtag, a word, "Question opener". */
  readonly label: string;
  readonly posts: number;
  /** Median audience of the group over the median of everything else. */
  readonly lift: number;
  readonly medianViews: number;
}

export interface Slot {
  readonly label: string;
  readonly posts: number;
  readonly medianViews: number;
}

export interface TopPost {
  readonly platform: Platform;
  readonly id: string;
  readonly url: string | null;
  readonly thumbnail: string | null;
  readonly hook: string;
  readonly publishedAt: string;
  readonly views: number | null;
  readonly engagement: number | null;
  /** Audience over the creator's median: 2.0 is twice their usual. */
  readonly index: number | null;
}

export interface Finding {
  readonly kind: 'topic' | 'hook' | 'length' | 'timing' | 'cadence' | 'trend';
  readonly text: string;
  /** The evidence, in the same words a person would check it with. */
  readonly evidence: string;
}

export interface InsightsReport {
  readonly posts: number;
  readonly windowDays: number;
  readonly totals: { readonly views: number; readonly likes: number; readonly comments: number; readonly shares: number };
  readonly medianViews: number | null;
  readonly medianEngagement: number | null;
  readonly postsPerWeek: number;
  /** Median views, last 30 days against the 30 before; null when either side is thin. */
  readonly trend: number | null;
  readonly weekly: readonly { readonly weekStart: string; readonly views: number; readonly posts: number }[];
  readonly top: readonly TopPost[];
  readonly topics: readonly Lift[];
  readonly hooks: readonly Lift[];
  readonly lengths: readonly Slot[];
  readonly days: readonly Slot[];
  readonly findings: readonly Finding[];
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Weekday in a time zone, without a date library. */
function weekdayIn(iso: string, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone }).format(new Date(iso));
  return DAYS.indexOf(name);
}

function liftsFor(
  posts: readonly SocialPost[],
  groupsOf: (post: SocialPost) => readonly string[],
  overall: number,
): Lift[] {
  const groups = new Map<string, number[]>();
  for (const post of posts) {
    const audience = audienceOf(post);
    if (audience === null) continue;
    for (const g of groupsOf(post)) {
      const list = groups.get(g) ?? [];
      list.push(audience);
      groups.set(g, list);
    }
  }
  const out: Lift[] = [];
  for (const [label, values] of groups) {
    if (values.length < MIN_GROUP) continue;
    const m = median(values)!;
    out.push({ label, posts: values.length, lift: overall > 0 ? round(m / overall) : 0, medianViews: Math.round(m) });
  }
  return out.sort((a, b) => b.lift - a.lift || b.posts - a.posts);
}

/** Two-sided split: a pattern against the posts without it. */
function splitLift(
  posts: readonly SocialPost[],
  has: (post: SocialPost) => boolean,
  label: string,
): Lift | null {
  const yes: number[] = [];
  const no: number[] = [];
  for (const p of posts) {
    const a = audienceOf(p);
    if (a === null) continue;
    (has(p) ? yes : no).push(a);
  }
  if (yes.length < MIN_GROUP || no.length < MIN_GROUP) return null;
  const my = median(yes)!;
  const mn = median(no)!;
  return { label, posts: yes.length, lift: mn > 0 ? round(my / mn) : 0, medianViews: Math.round(my) };
}

const fmtX = (lift: number): string => `${lift.toFixed(1)}×`;

export function buildReport(
  all: readonly SocialPost[],
  options: { now?: Date; windowDays?: number; timeZone?: string } = {},
): InsightsReport {
  const now = options.now ?? new Date();
  const windowDays = options.windowDays ?? 90;
  const timeZone = options.timeZone ?? 'Asia/Kolkata';
  const since = now.getTime() - windowDays * DAY_MS;
  const posts = all
    .filter((p) => Date.parse(p.publishedAt) >= since && Date.parse(p.publishedAt) <= now.getTime())
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

  const audiences = posts.map(audienceOf).filter((v): v is number => v !== null);
  const engagements = posts.map(engagementOf).filter((v): v is number => v !== null);
  const overall = median(audiences) ?? 0;

  const totals = {
    views: audiences.reduce((s, v) => s + v, 0),
    likes: posts.reduce((s, p) => s + p.likes, 0),
    comments: posts.reduce((s, p) => s + p.comments, 0),
    shares: posts.reduce((s, p) => s + (p.shares ?? 0), 0),
  };

  const recent = posts.filter((p) => Date.parse(p.publishedAt) >= now.getTime() - 28 * DAY_MS);
  const postsPerWeek = round(recent.length / 4, 1);

  const windowOf = (from: number, to: number) =>
    posts
      .filter((p) => {
        const t = Date.parse(p.publishedAt);
        return t >= now.getTime() - from * DAY_MS && t < now.getTime() - to * DAY_MS;
      })
      .map(audienceOf)
      .filter((v): v is number => v !== null);
  const last = windowOf(30, 0);
  const prior = windowOf(60, 30);
  const trend =
    last.length >= MIN_GROUP && prior.length >= MIN_GROUP && median(prior)! > 0
      ? round(median(last)! / median(prior)! - 1)
      : null;

  // Weekly totals, oldest first, for the chart. Weeks start on Monday, UTC.
  const weeks = new Map<string, { views: number; posts: number }>();
  for (const p of posts) {
    const d = new Date(p.publishedAt);
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
    const key = monday.toISOString().slice(0, 10);
    const w = weeks.get(key) ?? { views: 0, posts: 0 };
    w.views += audienceOf(p) ?? 0;
    w.posts += 1;
    weeks.set(key, w);
  }
  const weekly = [...weeks.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, w]) => ({ weekStart, ...w }));

  const top: TopPost[] = [...posts]
    .filter((p) => audienceOf(p) !== null)
    .sort((a, b) => (audienceOf(b) ?? 0) - (audienceOf(a) ?? 0))
    .slice(0, 6)
    .map((p) => ({
      platform: p.platform,
      id: p.id,
      url: p.url,
      thumbnail: p.thumbnail,
      hook: hookOf(p.caption).slice(0, 140),
      publishedAt: p.publishedAt,
      views: audienceOf(p),
      engagement: engagementOf(p) === null ? null : round(engagementOf(p)!, 4),
      index: overall > 0 ? round((audienceOf(p) ?? 0) / overall) : null,
    }));

  // A topic is reported only when it moves views at least 15% either way,
  // and only when it is not in most posts: a word in seven posts of ten
  // describes the account, not a choice, and cannot explain a difference.
  const topics = liftsFor(posts, (p) => [...hashtagsOf(p.caption), ...keywordsOf(p.caption)], overall)
    .filter((t) => Math.abs(t.lift - 1) >= 0.15 && t.posts <= Math.max(MIN_GROUP, posts.length * 0.7))
    .slice(0, 12);

  const hooks = [
    splitLift(posts, (p) => /\?|^(how|why|what|when|which|who|kya|kaise|kyun)\b/iu.test(hookOf(p.caption)), 'Opens with a question'),
    splitLift(posts, (p) => /\d/.test(hookOf(p.caption)), 'Number in the opening line'),
    splitLift(posts, (p) => hookOf(p.caption).split(/\s+/).filter(Boolean).length <= 8, 'Opening line of 8 words or fewer'),
    splitLift(posts, (p) => /\b(i|my|me|main|mera|meri)\b/iu.test(hookOf(p.caption)), 'Personal opener ("I", "my")'),
  ].filter((l): l is Lift => l !== null).sort((a, b) => b.lift - a.lift);

  const LENGTHS: readonly [string, number, number][] = [
    ['Under 15s', 0, 15],
    ['15–30s', 15, 30],
    ['30–60s', 30, 60],
    ['Over 60s', 60, Infinity],
  ];
  const lengths: Slot[] = [];
  for (const [label, lo, hi] of LENGTHS) {
    const values = posts
      .filter((p) => p.durationSec !== null && p.durationSec >= lo && p.durationSec < hi)
      .map(audienceOf)
      .filter((v): v is number => v !== null);
    if (values.length >= 2) lengths.push({ label, posts: values.length, medianViews: Math.round(median(values)!) });
  }

  const days: Slot[] = [];
  for (let d = 0; d < 7; d += 1) {
    const values = posts
      .filter((p) => weekdayIn(p.publishedAt, timeZone) === d)
      .map(audienceOf)
      .filter((v): v is number => v !== null);
    if (values.length >= 2) days.push({ label: DAYS[d]!, posts: values.length, medianViews: Math.round(median(values)!) });
  }

  // ── Findings, worded as the evidence supports ──────────────────────
  const findings: Finding[] = [];
  const bestTopic = topics.find((t) => t.lift >= 1.3);
  if (bestTopic) {
    findings.push({
      kind: 'topic',
      text: `“${bestTopic.label}” is your strongest subject. Make more on it.`,
      evidence: `${bestTopic.posts} posts, median ${bestTopic.medianViews.toLocaleString('en-IN')} views, ${fmtX(bestTopic.lift)} your usual.`,
    });
  }
  const weakTopic = [...topics].reverse().find((t) => t.lift <= 0.7);
  if (weakTopic) {
    findings.push({
      kind: 'topic',
      text: `“${weakTopic.label}” underperforms. Change the angle or drop it.`,
      evidence: `${weakTopic.posts} posts at ${fmtX(weakTopic.lift)} your usual views.`,
    });
  }
  const bestHook = hooks[0];
  if (bestHook && bestHook.lift >= 1.2) {
    findings.push({
      kind: 'hook',
      text: `${bestHook.label} works for you. Use it on the next script.`,
      evidence: `${bestHook.posts} posts like that got ${fmtX(bestHook.lift)} the views of the rest.`,
    });
  }
  if (lengths.length >= 2) {
    const best = [...lengths].sort((a, b) => b.medianViews - a.medianViews)[0]!;
    findings.push({
      kind: 'length',
      text: `${best.label} is your best length.`,
      evidence: `Median ${best.medianViews.toLocaleString('en-IN')} views across ${best.posts} posts.`,
    });
  }
  if (days.length >= 3) {
    const best = [...days].sort((a, b) => b.medianViews - a.medianViews)[0]!;
    findings.push({
      kind: 'timing',
      text: `${best.label} is your best day to post.`,
      evidence: `Median ${best.medianViews.toLocaleString('en-IN')} views across ${best.posts} posts (${timeZone}).`,
    });
  }
  if (trend !== null && Math.abs(trend) >= 0.15) {
    findings.push({
      kind: 'trend',
      text: trend > 0 ? 'Your views are rising.' : 'Your views are falling.',
      evidence: `Median views over the last 30 days are ${Math.abs(Math.round(trend * 100))}% ${trend > 0 ? 'above' : 'below'} the 30 before.`,
    });
  }
  findings.push({
    kind: 'cadence',
    text: postsPerWeek < 1 ? 'Post more often to learn faster.' : `You post about ${postsPerWeek} times a week.`,
    evidence: `${recent.length} posts in the last 28 days.`,
  });

  return {
    posts: posts.length,
    windowDays,
    totals,
    medianViews: overall > 0 ? Math.round(overall) : null,
    medianEngagement: engagements.length ? round(median(engagements)!, 4) : null,
    postsPerWeek,
    trend,
    weekly,
    top,
    topics,
    hooks,
    lengths,
    days,
    findings,
  };
}
