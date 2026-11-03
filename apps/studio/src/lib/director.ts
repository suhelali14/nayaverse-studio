import { DEFAULT_STYLE, speakingSeconds, type PlanStyle, type Scene, type ScenePlan } from './scenes.js';
import type { Word } from './subtitles.js';

/**
 * A scene plan, turned into a cut: which footage goes under which line, for
 * how long, and when each word appears on screen.
 *
 * ── Where this sits ─────────────────────────────────────────────────────
 *
 *     script ─► scenes.ts ─► director.ts ─► timeline ─► compose.ts ─► pixels
 *               (what)       (with what)    (editable)
 *
 * `scenes.ts` decides what is said and in what order. This module decides
 * what is on screen while it is said, and writes the result as plain shots
 * the editor turns into clips -- after which every one of them can be
 * dragged, trimmed, split and recaptioned like anything the creator placed
 * by hand. A generated edit that cannot be edited is a rendering, not an
 * edit, and the whole value of doing this inside an editor is that it is
 * a first draft rather than a final answer.
 *
 * ── How footage is chosen, and why it is keyword matching ───────────────
 *
 * Each scene carries a `visual` query. Footage is matched on the creator's
 * own file names, which they chose, and which for a phone library of tens
 * of clips are a better signal than they look: `reception-desk.mp4`,
 * `IMG_dr_consult.jpg`. Every choice records *why* it was made -- the
 * words it matched on, or that it was a fill, or that nothing fitted and a
 * text card was used -- and the editor shows that reason beside the shot,
 * because a choice a person cannot audit is one they have to redo.
 *
 * A semantic index would do better on a large library, and the seam for
 * one is `AssetRetriever` in `scenes.ts`. This is the baseline it has to
 * beat, and it works with no model and no network.
 *
 * ── Word timing before there is any audio ───────────────────────────────
 *
 * A faceless reel is planned before it is voiced, but its captions are the
 * product. So each shot's words are paced across the shot at the plan's
 * reading rate, length-weighted, giving real word-by-word cues on the
 * timeline from the first click. When a narration exists, `align.ts`
 * replaces these with the audio's timing and keeps the same text.
 */

export interface LibraryItem {
  /** The file's name, which is also the path the editor keys media by. */
  readonly name: string;
  readonly kind: 'photo' | 'clip';
  /** Length of a clip in seconds. Ignored for photos. */
  readonly seconds: number | null;
}

export type DirectedSource =
  | { readonly kind: 'solid'; readonly label: string }
  | { readonly kind: 'photo'; readonly path: string }
  | { readonly kind: 'clip'; readonly path: string; readonly from: number; readonly to: number };

export type MatchReason =
  /** The file name shares these words with the scene. */
  | { readonly kind: 'keyword'; readonly on: readonly string[] }
  /** Nothing matched, so the next footage not yet used was placed. */
  | { readonly kind: 'fill' }
  /** No footage fitted at all; the line is set as a text card. */
  | { readonly kind: 'card' };

export interface DirectedShot {
  readonly role: 'hook' | 'scene' | 'cta';
  readonly text: string;
  readonly visual: string;
  readonly seconds: number;
  readonly source: DirectedSource;
  /** Word timings in the shot's own clock, starting at 0. */
  readonly words: readonly Word[];
  readonly match: MatchReason;
}

export interface DirectedReel {
  readonly shots: readonly DirectedShot[];
  readonly totalSeconds: number;
  /** Shots set as text cards because nothing in the library fitted. */
  readonly cards: number;
  /** Shots given footage that matched nothing, to keep the picture moving. */
  readonly fills: number;
}

export interface DirectOptions {
  readonly style?: PlanStyle;
  /**
   * Place unmatched footage rather than a text card when nothing matches.
   * On by default: a creator who uploaded b-roll for this reel wants it
   * used, and a run of text cards between matched clips reads as broken.
   */
  readonly fill?: boolean;
}

/** No shot is shorter than this: under it, a cut reads as a glitch. */
export const MIN_SHOT_SECONDS = 1.6;

/**
 * Silence after the last word of a shot, before the cut.
 *
 * Cutting on the last syllable makes every shot feel clipped. A third of a
 * second is the breath a narrator would take, and it is what lets the
 * viewer finish reading the caption before the picture changes under it.
 */
export const SHOT_TAIL_SECONDS = 0.35;

/** Before the first word of a shot, so a caption never lands on the cut. */
const LEAD_IN_MS = 120;

const ms = (s: number): number => Math.round(s * 1000);
const snap = (s: number): number => Math.round(s * 1000) / 1000;

export function shotSeconds(scene: Scene, style: PlanStyle = DEFAULT_STYLE): number {
  const spoken = speakingSeconds(scene.text, style);
  return snap(Math.max(MIN_SHOT_SECONDS, spoken + SHOT_TAIL_SECONDS));
}

/**
 * Spread a line's words across a shot.
 *
 * Length-weighted with a base of one per word, so a long word takes longer
 * than a short one but "a" is never a zero-length flash. Ends a little
 * before the shot does, which is the same breath `SHOT_TAIL_SECONDS` gives.
 */
export function paceWords(text: string, seconds: number): Word[] {
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return [];
  const startMs = Math.min(LEAD_IN_MS, ms(seconds) / 4);
  const endMs = Math.max(startMs + tokens.length, ms(seconds) - ms(SHOT_TAIL_SECONDS) * 0.6);
  const weight = (t: string): number => 1 + t.length;
  const total = tokens.reduce((sum, t) => sum + weight(t), 0);

  let at = startMs;
  return tokens.map((text) => {
    const span = ((endMs - startMs) * weight(text)) / total;
    const word: Word = {
      text,
      startMs: Math.round(at),
      endMs: Math.round(at + span),
      // Planned, not heard. Full confidence because nothing is uncertain
      // about it -- it is exactly the script -- and the timing is replaced
      // wholesale once there is a narration to align against.
      confidence: 1,
    };
    at += span;
    return word;
  });
}

// ---------------------------------------------------------------------------
// Matching.

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'your', 'you', 'our', 'that', 'this', 'from', 'are',
  'was', 'img', 'vid', 'mov', 'mp4', 'jpg', 'jpeg', 'png', 'heic', 'webp', 'final',
  'copy', 'edit', 'export', 'clip', 'video', 'photo', 'image', 'whatsapp', 'screenshot',
]);

/**
 * The words in a name or a line, for matching.
 *
 * Splits on anything that is not a letter or digit *and* on camelCase, so
 * `drConsultRoom2.mp4` and `dr_consult_room.mp4` produce the same words.
 * A trailing plural `s` is dropped on both sides so "patients" finds
 * `patient-queue.jpg`. Digits alone are dropped: `IMG_20260114` is a date,
 * not a subject.
 */
export function matchWords(text: string): Set<string> {
  const out = new Set<string>();
  const spaced = text
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    // `room2`, `take3b`: a take number is not part of the subject.
    .replace(/(\p{L})(\d)/gu, '$1 $2')
    .replace(/(\d)(\p{L})/gu, '$1 $2')
    .toLowerCase();
  for (const raw of spaced.split(/[^\p{L}\p{N}\p{M}]+/u)) {
    if (raw.length < 3 || /^\d+$/.test(raw) || STOPWORDS.has(raw)) continue;
    out.add(raw.length > 3 && raw.endsWith('s') ? raw.slice(0, -1) : raw);
  }
  return out;
}

interface Candidate {
  readonly item: LibraryItem;
  readonly words: Set<string>;
  uses: number;
  /** For clips: how far into the file the next use starts. */
  cursor: number;
}

const fits = (c: Candidate, seconds: number): boolean =>
  c.item.kind === 'photo' || (c.item.seconds ?? 0) - c.cursor >= seconds;

function scoreFor(c: Candidate, visual: Set<string>, spoken: Set<string>): { score: number; on: string[] } {
  const on: string[] = [];
  let score = 0;
  for (const w of c.words) {
    // The visual query is what the scene asked to see; the spoken words
    // are a weaker hint. A match on what is *shown* is worth twice one on
    // what is merely *said*.
    if (visual.has(w)) {
      score += 2;
      on.push(w);
    } else if (spoken.has(w)) {
      score += 1;
      on.push(w);
    }
  }
  // Reuse is allowed -- a library of three clips still makes a reel of
  // six scenes -- but costs enough that a fresh match wins a tie.
  return { score: score - c.uses * 0.75, on };
}

/**
 * Direct a reel from a plan and a library.
 *
 * Deterministic: the same plan and library always produce the same cut,
 * which is what lets the editor re-run it after a script change without
 * the picture shuffling under the creator for no reason.
 */
export function directReel(
  plan: ScenePlan,
  library: readonly LibraryItem[],
  options: DirectOptions = {},
): DirectedReel {
  const style = options.style ?? DEFAULT_STYLE;
  const fill = options.fill ?? true;

  const scenes: { role: DirectedShot['role']; scene: Scene }[] = [
    ...(plan.hook.text.trim() ? [{ role: 'hook' as const, scene: plan.hook }] : []),
    ...plan.scenes.map((scene) => ({ role: 'scene' as const, scene })),
    ...(plan.cta ? [{ role: 'cta' as const, scene: plan.cta }] : []),
  ];

  const pool: Candidate[] = library.map((item) => ({
    item,
    words: matchWords(item.name),
    uses: 0,
    cursor: 0,
  }));

  const shots: DirectedShot[] = [];
  let cards = 0;
  let fills = 0;

  scenes.forEach(({ role, scene }) => {
    const seconds = shotSeconds(scene, style);
    const visual = matchWords(scene.visual);
    const spoken = matchWords(scene.text);

    let best: { c: Candidate; on: string[]; score: number } | null = null;
    for (const c of pool) {
      if (!fits(c, seconds)) continue;
      const { score, on } = scoreFor(c, visual, spoken);
      if (on.length === 0) continue;
      if (!best || score > best.score) best = { c, on, score };
    }

    let chosen: Candidate | null = best && best.score > 0 ? best.c : null;
    let match: MatchReason = chosen ? { kind: 'keyword', on: best!.on } : { kind: 'card' };

    if (!chosen && fill) {
      // The least-used footage that fits, earliest in the library first, so
      // a fill spreads across everything uploaded rather than repeating the
      // first clip.
      const spare = pool
        .filter((c) => fits(c, seconds))
        .sort((a, b) => a.uses - b.uses)[0];
      if (spare) {
        chosen = spare;
        match = { kind: 'fill' };
      }
    }

    let source: DirectedSource;
    if (!chosen) {
      // No label. A solid card's label is drawn into the picture by the
      // renderer, so "Scene 2" here would be burnt into the creator's reel.
      // The role is the editor's to show, in its running order, not the
      // viewer's to read.
      source = { kind: 'solid', label: '' };
      cards += 1;
    } else if (chosen.item.kind === 'photo') {
      source = { kind: 'photo', path: chosen.item.name };
    } else {
      // Successive uses of one clip take successive stretches of it, so a
      // single long b-roll take can carry several scenes without showing
      // the same two seconds twice.
      const from = snap(chosen.cursor);
      source = { kind: 'clip', path: chosen.item.name, from, to: snap(from + seconds) };
      chosen.cursor = snap(from + seconds);
    }
    if (chosen) chosen.uses += 1;
    if (match.kind === 'fill') fills += 1;

    shots.push({
      role,
      text: scene.text,
      visual: scene.visual,
      seconds,
      source,
      words: paceWords(scene.text, seconds),
      match,
    });
  });

  return {
    shots,
    totalSeconds: snap(shots.reduce((sum, s) => sum + s.seconds, 0)),
    cards,
    fills,
  };
}
