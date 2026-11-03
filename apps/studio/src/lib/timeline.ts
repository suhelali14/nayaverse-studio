import type { Post, Shot } from './store.js';

/**
 * The edit, as a document.
 *
 * ── Why this exists before any editor UI ─────────────────────────────
 *
 * The thing that makes an editor trustworthy is not its timeline widget,
 * it is that the preview and the export cannot disagree. The only way to
 * get that is for both to read one document, and for every operation a
 * user performs to be a pure function on it. Drag, trim, split and ripple
 * then become testable without a browser, which is why this module has a
 * test file and the UI will not need one for geometry.
 *
 * This repo has done this before: `canvas-doc.ts` is the website editor's
 * document with 103 geometry tests, and those tests became the thing the
 * renderer had to agree with rather than the other way round.
 *
 * ── Why seconds and not frames ───────────────────────────────────────
 *
 * Frames are the correct unit for a finishing tool, because 1/30 of a
 * second is not representable in binary floating point and rounding
 * accumulates along a timeline. This uses seconds rounded to milliseconds
 * at every boundary, which is wrong for broadcast and right here: the
 * sources are phone recordings at variable frame rates, the output is one
 * fixed 30fps encode, and a millisecond is a third of a frame. Recorded so
 * that whoever hits a sync bug knows exactly which assumption to revisit.
 */

/** Milliseconds, as a fraction of a second. Every boundary snaps to this. */
const TICK = 0.001;
const snap = (n: number): number => Math.round(n / TICK) * TICK;

/** `video` is the main, magnetic track; `overlay` cuts away over it; `audio` is sound only. */
export type TrackKind = 'video' | 'overlay' | 'audio';

export interface Clip {
  readonly id: string;
  /** Where it sits on the timeline. */
  start: number;
  /** How long it plays for. Never zero or negative. */
  duration: number;
  /** Where playback begins inside the source. Meaningless for cards. */
  sourceIn: number;
  /** Burnt-in words. Empty is allowed; a clip may carry no caption. */
  caption: string;
  source: Shot['source'];
  /** Linear gain for the clip's sound, 1 = as recorded. Absent means 1. */
  volume?: number;
  /** Playback speed of the source, 1 = real time. Absent means 1. */
  speed?: number;
  /** Picture adjustments. Absent means as shot. */
  grade?: Grade;
  /** Zoom at the clip's first and last frame, for a slow push in or out. */
  zoom?: { readonly from: number; readonly to: number };
  /** Seconds of fade from and to black at the clip's edges. */
  fadeIn?: number;
  fadeOut?: number;
}

/** 1 is neutral for the first three; warmth runs -1 (cool) to 1 (warm). */
export interface Grade {
  readonly exposure: number;
  readonly contrast: number;
  readonly saturation: number;
  readonly warmth: number;
}

export interface Track {
  readonly id: string;
  readonly kind: TrackKind;
  clips: Clip[];
}

export interface Timeline {
  readonly fps: number;
  tracks: Track[];
}

export const emptyTimeline = (fps = 30): Timeline => ({
  fps,
  tracks: [{ id: 'v1', kind: 'video', clips: [] }],
});

const trackOf = (t: Timeline, id: string): Track => {
  const track = t.tracks.find((x) => x.id === id);
  if (!track) throw new Error(`No track "${id}".`);
  return track;
};

/** Clips in play order. The array is kept sorted; this is the guarantee. */
const sorted = (clips: Clip[]): Clip[] => [...clips].sort((a, b) => a.start - b.start);

export const endOf = (c: Clip): number => snap(c.start + c.duration);

export const duration = (t: Timeline): number =>
  t.tracks.reduce((max, tr) => Math.max(max, ...tr.clips.map(endOf), 0), 0);

// ---------------------------------------------------------------------------
// Operations. Every one returns a new timeline; none mutates its input.

const replaceTrack = (t: Timeline, id: string, clips: Clip[]): Timeline => ({
  ...t,
  tracks: t.tracks.map((tr) => (tr.id === id ? { ...tr, clips: sorted(clips) } : tr)),
});

/**
 * Lay clips end to end from zero, closing every gap.
 *
 * The operation a script-driven edit needs constantly: beats are reordered
 * and the result must still be a continuous reel, because a one-frame black
 * gap between beats is the most visible defect a reel can have.
 */
export function compact(t: Timeline, trackId: string): Timeline {
  let at = 0;
  const clips = sorted(trackOf(t, trackId).clips).map((c) => {
    const moved = { ...c, start: snap(at) };
    at += c.duration;
    return moved;
  });
  return replaceTrack(t, trackId, clips);
}

export function append(t: Timeline, trackId: string, clip: Omit<Clip, 'start'>): Timeline {
  const track = trackOf(t, trackId);
  const at = track.clips.length ? Math.max(...track.clips.map(endOf)) : 0;
  return replaceTrack(t, trackId, [...track.clips, { ...clip, start: snap(at) }]);
}

/**
 * Cut a clip in two at an absolute time.
 *
 * The second half starts further into the source, which is the whole point:
 * splitting and deleting the first half must not rewind the footage.
 */
export function splitAt(t: Timeline, trackId: string, at: number): Timeline {
  const time = snap(at);
  const clips = trackOf(t, trackId).clips.flatMap((c) => {
    // Strictly inside: a split exactly on a boundary is a no-op, not a
    // zero-length clip. Zero-length clips are how a timeline gets a
    // division by zero three operations later.
    if (time <= c.start || time >= endOf(c)) return [c];
    const firstLen = snap(time - c.start);
    return [
      { ...c, duration: firstLen },
      {
        ...c,
        id: `${c.id}-b`,
        start: time,
        duration: snap(c.duration - firstLen),
        sourceIn: snap(c.sourceIn + firstLen),
      },
    ];
  });
  return replaceTrack(t, trackId, clips);
}

export type Edge = 'in' | 'out';

/**
 * Drag one end of a clip.
 *
 * Trimming the in-point moves the source position too, so the frame under
 * the playhead does not jump -- the behaviour every editor has and whose
 * absence is immediately obvious. A trim can never invert a clip or run
 * past the end of its source.
 */
export function trim(
  t: Timeline,
  trackId: string,
  clipId: string,
  edge: Edge,
  delta: number,
  sourceDuration?: number,
): Timeline {
  const clips = trackOf(t, trackId).clips.map((c) => {
    if (c.id !== clipId) return c;
    if (edge === 'out') {
      let dur = snap(c.duration + delta);
      dur = Math.max(TICK, dur);
      if (sourceDuration !== undefined) {
        dur = Math.min(dur, snap(sourceDuration - c.sourceIn));
      }
      return { ...c, duration: Math.max(TICK, dur) };
    }
    // Pulling the in-point right shortens the clip and advances the source.
    let move = snap(delta);
    move = Math.max(move, -c.sourceIn); // cannot start before the source does
    move = Math.min(move, snap(c.duration - TICK)); // cannot invert
    return {
      ...c,
      start: snap(c.start + move),
      duration: snap(c.duration - move),
      sourceIn: snap(c.sourceIn + move),
    };
  });
  return replaceTrack(t, trackId, clips);
}

/** Remove a clip and close the hole it leaves. */
export function rippleDelete(t: Timeline, trackId: string, clipId: string): Timeline {
  const kept = trackOf(t, trackId).clips.filter((c) => c.id !== clipId);
  return compact(replaceTrack(t, trackId, kept), trackId);
}

/** Move a clip to a new index in play order, then close the gaps. */
export function reorder(t: Timeline, trackId: string, clipId: string, toIndex: number): Timeline {
  const clips = sorted(trackOf(t, trackId).clips);
  const from = clips.findIndex((c) => c.id === clipId);
  if (from === -1) throw new Error(`No clip "${clipId}" on track "${trackId}".`);
  const target = Math.max(0, Math.min(clips.length - 1, toIndex));
  const [moved] = clips.splice(from, 1);
  clips.splice(target, 0, moved!);
  // Re-stamped in array order, because compact() reads `start` and the
  // array order is what the caller just expressed an intention about.
  let at = 0;
  const laid = clips.map((c) => {
    const next = { ...c, start: snap(at) };
    at += c.duration;
    return next;
  });
  return replaceTrack(t, trackId, laid);
}

/**
 * Put a clip into play order straight after another (or first, for null),
 * then close the gaps. Duplicate and paste are this: the copy lands next to
 * what it came from, and everything after it moves along.
 */
export function insertAfter(
  t: Timeline,
  trackId: string,
  afterId: string | null,
  clip: Omit<Clip, 'start'>,
): Timeline {
  const clips = sorted(trackOf(t, trackId).clips);
  if (clips.some((c) => c.id === clip.id)) throw new Error(`Clip "${clip.id}" is already on track "${trackId}".`);
  const at = afterId === null ? 0 : clips.findIndex((c) => c.id === afterId) + 1;
  if (afterId !== null && at === 0) throw new Error(`No clip "${afterId}" on track "${trackId}".`);
  clips.splice(at, 0, { ...clip, start: 0 });
  let time = 0;
  const laid = clips.map((c) => {
    const next = { ...c, start: snap(time) };
    time += c.duration;
    return next;
  });
  return replaceTrack(t, trackId, laid);
}

// ---------------------------------------------------------------------------
// Invariants. Checked in tests, and cheap enough to check in a UI too.

export interface Problem {
  readonly clip: string;
  readonly what: string;
}

export function validate(t: Timeline): Problem[] {
  const out: Problem[] = [];
  for (const track of t.tracks) {
    const clips = sorted(track.clips);
    for (const c of clips) {
      if (c.duration <= 0) out.push({ clip: c.id, what: 'duration is zero or negative' });
      if (c.start < 0) out.push({ clip: c.id, what: 'starts before zero' });
      if (c.sourceIn < 0) out.push({ clip: c.id, what: 'source in-point is negative' });
    }
    // Overlap matters on a video track -- two clips at one instant have no
    // defined winner -- and is the normal case on an overlay track.
    if (track.kind === 'video') {
      for (let i = 1; i < clips.length; i += 1) {
        const prev = clips[i - 1]!;
        const cur = clips[i]!;
        if (cur.start < endOf(prev) - TICK / 2) {
          out.push({ clip: cur.id, what: `overlaps ${prev.id}` });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Conversions.

/** A drafted post becomes an editable timeline. */
export function fromPost(post: Post): Timeline {
  let at = 0;
  const clips: Clip[] = post.shots.map((s, i) => {
    const c: Clip = {
      id: `c${i + 1}`,
      start: snap(at),
      duration: s.seconds,
      sourceIn: s.source.kind === 'clip' ? s.source.from : 0,
      caption: s.caption,
      source: s.source,
    };
    at += s.seconds;
    return c;
  });
  return { fps: 30, tracks: [{ id: 'v1', kind: 'video', clips }] };
}

/**
 * The timeline, as the shot list the renderer already understands.
 *
 * Deliberately lossy in one direction only: the renderer plays shots back
 * to back, so a timeline with gaps is compacted here rather than rendered
 * with black. A gap in a 20-second reel is a mistake every time.
 */
export function toShots(t: Timeline): Shot[] {
  const track = t.tracks.find((x) => x.kind === 'video');
  if (!track) return [];
  return sorted(track.clips).map((c) => ({
    seconds: Number(c.duration.toFixed(3)),
    caption: c.caption,
    source:
      c.source.kind === 'clip'
        ? { kind: 'clip' as const, path: c.source.path, from: c.sourceIn, to: snap(c.sourceIn + c.duration) }
        : c.source,
  }));
}

/**
 * OpenTimelineIO, the interchange format the film industry settled on.
 *
 * ── Why a tool meant to keep creators would export its own edits ─────
 *
 * Because the alternative does not work. A creator evaluating a new editor
 * asks what happens to their work if they stop using it, and "nothing comes
 * out" ends the evaluation. OTIO is read by Resolve, Premiere via adapters,
 * Kdenlive and Olive, so an edit started here can be finished anywhere.
 *
 * That is not a concession. A tool nobody can leave is a tool nobody tries,
 * and the thing that keeps people is being better at the daily job, not
 * being a trap. Exporting also costs about forty lines.
 */
export function toOTIO(t: Timeline, name = 'studio edit'): unknown {
  const rate = t.fps;
  const time = (seconds: number) => ({
    OTIO_SCHEMA: 'RationalTime.1',
    rate,
    value: Math.round(seconds * rate),
  });
  return {
    OTIO_SCHEMA: 'Timeline.1',
    name,
    global_start_time: time(0),
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      children: t.tracks.map((track) => ({
        OTIO_SCHEMA: 'Track.1',
        name: track.id,
        kind: 'Video',
        children: sorted(track.clips).map((c) => ({
          OTIO_SCHEMA: 'Clip.1',
          name: c.caption || c.id,
          source_range: {
            OTIO_SCHEMA: 'TimeRange.1',
            start_time: time(c.sourceIn),
            duration: time(c.duration),
          },
          media_reference:
            c.source.kind === 'clip' || c.source.kind === 'photo' || c.source.kind === 'asset'
              ? {
                  OTIO_SCHEMA: 'ExternalReference.1',
                  target_url: c.source.path,
                }
              : { OTIO_SCHEMA: 'MissingReference.1', name: 'title card' },
        })),
      })),
    },
  };
}
