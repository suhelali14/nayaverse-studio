import { compact, trim, type Clip, type Grade, type Timeline } from './timeline.js';

/**
 * The editor's pass: what a professional does to a rough cut before it
 * goes out, proposed as a list of changes the creator can take or leave.
 *
 *   on the beat     every cut on the main track moved to the nearest beat
 *                   of the music, when one is close enough to feel deliberate
 *   open strong     a push in on the hook, and no fade from black before it
 *   keep it moving  a slow push on still pictures held long enough to sit dead
 *   land it         a short fade out on the last shot
 *   one look        the same grade across the reel, so it reads as one piece
 *   sound           music under the voice when the clips carry speech
 *
 * Pure functions over the timeline document and raw samples, so every rule
 * is tested without a browser. Nothing here applies itself: `planPolish`
 * describes, `applyPolish` does exactly what was chosen.
 */

// ---------------------------------------------------------------------------
// Beats.

export interface Beats {
  /** Seconds into the sound, from its first sample. */
  readonly times: readonly number[];
  readonly bpm: number | null;
}

/**
 * Onsets in a sound, then the steady beat they imply.
 *
 * Energy in short hops, its rise from one hop to the next (where a drum or
 * a pluck starts), peaks above a local threshold. The tempo is the lag at
 * which that onset curve best matches itself, between 60 and 180 BPM; the
 * grid is laid at that period through the strongest onsets.
 */
export function detectBeats(samples: Float32Array, sampleRate: number): Beats {
  const hop = Math.max(64, Math.round(sampleRate / 100)); // ~10ms
  const frames = Math.floor(samples.length / hop);
  if (frames < 50) return { times: [], bpm: null };
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f += 1) {
    let sum = 0;
    for (let i = f * hop; i < (f + 1) * hop; i += 1) sum += samples[i]! * samples[i]!;
    energy[f] = Math.sqrt(sum / hop);
  }
  const flux = new Float32Array(frames);
  for (let f = 1; f < frames; f += 1) flux[f] = Math.max(0, energy[f]! - energy[f - 1]!);

  // Peaks above the local mean plus some of the local spread.
  const win = 25;
  const onsets: { frame: number; strength: number }[] = [];
  for (let f = 1; f < frames - 1; f += 1) {
    let mean = 0;
    let n = 0;
    for (let k = Math.max(0, f - win); k < Math.min(frames, f + win); k += 1) {
      mean += flux[k]!;
      n += 1;
    }
    mean /= n;
    let varSum = 0;
    for (let k = Math.max(0, f - win); k < Math.min(frames, f + win); k += 1) varSum += (flux[k]! - mean) ** 2;
    const threshold = mean + 0.8 * Math.sqrt(varSum / n);
    if (flux[f]! > threshold && flux[f]! >= flux[f - 1]! && flux[f]! >= flux[f + 1]! && flux[f]! > 1e-4) {
      const last = onsets[onsets.length - 1];
      // Two onsets closer than 120ms are one sound.
      if (last && f - last.frame < 12) {
        if (flux[f]! > last.strength) onsets[onsets.length - 1] = { frame: f, strength: flux[f]! };
      } else onsets.push({ frame: f, strength: flux[f]! });
    }
  }
  if (onsets.length < 4) return { times: onsets.map((o) => (o.frame * hop) / sampleRate), bpm: null };

  // Tempo by autocorrelation of the onset curve.
  const hopSec = hop / sampleRate;
  const minLag = Math.round(60 / 180 / hopSec);
  const maxLag = Math.round(60 / 60 / hopSec);
  let bestLag = 0;
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let s = 0;
    for (let f = 0; f + lag < frames; f += 1) s += flux[f]! * flux[f + lag]!;
    // A slight lean toward the middle of the range, so a beat is not read
    // as its own half or double when the two score alike.
    const bpm = 60 / (lag * hopSec);
    s *= 1 - Math.min(0.25, Math.abs(bpm - 110) / 400);
    if (s > best) {
      best = s;
      bestLag = lag;
    }
  }
  if (bestLag === 0) return { times: onsets.map((o) => (o.frame * hopSec)), bpm: null };
  const period = bestLag * hopSec;

  // Phase: the offset at which the grid passes through the most onset energy.
  let bestPhase = 0;
  let bestScore = -1;
  for (let p = 0; p < bestLag; p += 1) {
    let s = 0;
    for (let f = p; f < frames; f += bestLag) s += flux[f]! + (flux[f - 1] ?? 0) + (flux[f + 1] ?? 0);
    if (s > bestScore) {
      bestScore = s;
      bestPhase = p;
    }
  }
  const duration = samples.length / sampleRate;
  const times: number[] = [];
  for (let t = bestPhase * hopSec; t < duration; t += period) times.push(Number(t.toFixed(4)));
  return { times, bpm: Math.round(60 / period) };
}

// ---------------------------------------------------------------------------
// The plan.

export type PolishChange =
  | { readonly kind: 'trimOut'; readonly id: string; readonly delta: number }
  | { readonly kind: 'zoom'; readonly id: string; readonly zoom: { readonly from: number; readonly to: number } | null }
  | { readonly kind: 'fade'; readonly id: string; readonly fadeIn?: number; readonly fadeOut?: number }
  | { readonly kind: 'look'; readonly id: string; readonly grade: Grade }
  | { readonly kind: 'volume'; readonly id: string; readonly volume: number };

export interface Suggestion {
  readonly key: string;
  /** What changes, in a line. */
  readonly title: string;
  /** Why an editor would do it. */
  readonly reason: string;
  readonly changes: readonly PolishChange[];
}

export interface PolishInput {
  readonly timeline: Timeline;
  /** Beats in timeline seconds, already placed where the music sits. */
  readonly beats: readonly number[];
  /** Whether the main track's clips carry their own sound (speech). */
  readonly voice: boolean;
  /** A grade the model or the creator wants the whole reel in. */
  readonly look?: { readonly label: string; readonly grade: Grade; readonly reason: string } | null;
  /** Scenes (by main-track id) worth a push in for emphasis, with why. */
  readonly emphasis?: readonly { readonly id: string; readonly reason: string }[];
  readonly labelOf?: (clip: Clip) => string;
}

/** The furthest a cut moves to meet a beat: beyond this it is a different edit. */
export const BEAT_REACH = 0.35;
/** No clip is cut shorter than this to make a beat. */
export const MIN_SHOT = 1;

const PUSH_IN = { from: 1, to: 1.12 } as const;
const SLOW_IN = { from: 1, to: 1.08 } as const;
const SLOW_OUT = { from: 1.08, to: 1 } as const;

const mainOf = (t: Timeline): Clip[] => [...(t.tracks.find((x) => x.id === 'v1')?.clips ?? [])].sort((a, b) => a.start - b.start);
const sameGrade = (a: Grade | undefined, b: Grade) =>
  a !== undefined && a.exposure === b.exposure && a.contrast === b.contrast && a.saturation === b.saturation && a.warmth === b.warmth;

export function planPolish(input: PolishInput): Suggestion[] {
  const out: Suggestion[] = [];
  const main = mainOf(input.timeline);
  if (main.length === 0) return out;
  const name = input.labelOf ?? ((c: Clip) => c.caption || c.id);

  // On the beat. Cuts are moved in order, because moving one moves every
  // cut after it; each is measured on the timeline as the earlier moves
  // leave it.
  if (input.beats.length > 1) {
    const changes: PolishChange[] = [];
    let shift = 0;
    for (let i = 0; i < main.length - 1; i += 1) {
      const c = main[i]!;
      const cut = c.start + shift + c.duration;
      const beat = input.beats.reduce((b, t) => (Math.abs(t - cut) < Math.abs(b - cut) ? t : b), input.beats[0]!);
      const delta = Number((beat - cut).toFixed(3));
      if (Math.abs(delta) < 1 / 30 || Math.abs(delta) > BEAT_REACH || c.duration + delta < MIN_SHOT) continue;
      changes.push({ kind: 'trimOut', id: c.id, delta });
      shift += delta;
    }
    if (changes.length) {
      out.push({
        key: 'beats',
        title: `Cut on the beat: ${changes.length} of ${main.length - 1} cuts move to the music`,
        reason: 'A cut that lands on a beat feels intended; one just off it feels late. None moves more than a third of a second.',
        changes,
      });
    }
  }

  // Open strong.
  const hook = main[0]!;
  if (!hook.zoom) {
    out.push({
      key: 'hook-push',
      title: `Push in on the opening shot (${name(hook)})`,
      reason: 'A slow push in on the first shot gives the opening line energy before anything has happened yet.',
      changes: [{ kind: 'zoom', id: hook.id, zoom: PUSH_IN }],
    });
  }
  if ((hook.fadeIn ?? 0) > 0) {
    out.push({
      key: 'hook-fade',
      title: 'Start on the picture, not from black',
      reason: 'A reel is judged in its first second; a fade from black spends it on nothing.',
      changes: [{ kind: 'fade', id: hook.id, fadeIn: 0 }],
    });
  }

  // Emphasis the model asked for, where nothing is set yet.
  const emphasised = new Set<string>();
  for (const e of input.emphasis ?? []) {
    const c = main.find((x) => x.id === e.id);
    if (!c || c.id === hook.id || c.zoom) continue;
    emphasised.add(c.id);
    out.push({ key: `emphasis-${c.id}`, title: `Push in on ${name(c)}`, reason: e.reason, changes: [{ kind: 'zoom', id: c.id, zoom: PUSH_IN }] });
  }

  // Keep stills moving: a picture held still for long reads as a pause.
  const stills = main.slice(1).filter((c) => c.source.kind === 'photo' && !c.zoom && !emphasised.has(c.id) && c.duration >= 2.5);
  if (stills.length) {
    out.push({
      key: 'stills',
      title: `Slow push on ${stills.length} still ${stills.length === 1 ? 'picture' : 'pictures'}`,
      reason: 'A photo held without movement for more than a couple of seconds reads as the reel stalling; a slow push keeps it alive.',
      changes: stills.map((c, i) => ({ kind: 'zoom', id: c.id, zoom: i % 2 === 0 ? SLOW_IN : SLOW_OUT })),
    });
  }

  // Land it.
  const last = main[main.length - 1]!;
  if (main.length > 1 && !(last.fadeOut && last.fadeOut > 0)) {
    out.push({
      key: 'end-fade',
      title: 'Fade out the last shot',
      reason: 'A short fade at the end tells the viewer the reel is over on purpose, not cut off.',
      changes: [{ kind: 'fade', id: last.id, fadeOut: 0.5 }],
    });
  }

  // One look.
  if (input.look) {
    const grade = input.look.grade;
    const off = main.filter((c) => !sameGrade(c.grade, grade));
    if (off.length) {
      out.push({
        key: 'look',
        title: `One look across the reel: ${input.look.label}`,
        reason: input.look.reason,
        changes: off.map((c) => ({ kind: 'look', id: c.id, grade })),
      });
    }
  }

  // Sound: music sits under speech, or carries a reel with none.
  const music = input.timeline.tracks.find((x) => x.id === 'a1')?.clips ?? [];
  const level = input.voice ? 0.25 : 0.8;
  const loud = music.filter((m) => Math.abs((m.volume ?? 1) - level) > 0.05);
  if (loud.length) {
    out.push({
      key: 'music',
      title: input.voice ? 'Music under the voice, at 25%' : 'Music up, at 80%, with no voice to sit under',
      reason: input.voice
        ? 'Speech has to win. Music at a quarter of full level sits under a voice without fighting it.'
        : 'With no one speaking, the music is the soundtrack and can carry the reel.',
      changes: loud.map((m) => ({ kind: 'volume', id: m.id, volume: level })),
    });
  }
  return out;
}

/** Apply chosen changes in order, as one edit. */
export function applyPolish(t: Timeline, changes: readonly PolishChange[]): Timeline {
  let next = t;
  const map = (id: string, f: (c: Clip) => Clip) => {
    next = { ...next, tracks: next.tracks.map((tr) => ({ ...tr, clips: tr.clips.map((c) => (c.id === id ? f(c) : c)) })) };
  };
  for (const ch of changes) {
    switch (ch.kind) {
      case 'trimOut':
        if (mainOf(next).some((c) => c.id === ch.id)) next = compact(trim(next, 'v1', ch.id, 'out', ch.delta), 'v1');
        break;
      case 'zoom':
        map(ch.id, (c) => {
          const n = { ...c };
          if (ch.zoom === null) delete n.zoom;
          else n.zoom = ch.zoom;
          return n;
        });
        break;
      case 'fade':
        map(ch.id, (c) => ({ ...c, ...(ch.fadeIn !== undefined ? { fadeIn: ch.fadeIn } : {}), ...(ch.fadeOut !== undefined ? { fadeOut: ch.fadeOut } : {}) }));
        break;
      case 'look':
        map(ch.id, (c) => ({ ...c, grade: ch.grade }));
        break;
      case 'volume':
        map(ch.id, (c) => ({ ...c, volume: ch.volume }));
        break;
    }
  }
  return next;
}
