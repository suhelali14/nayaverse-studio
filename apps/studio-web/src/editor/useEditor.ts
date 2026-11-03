import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FRAME_FPS,
  FRAME_H,
  FRAME_W,
  composeFrame,
  type SourceSize,
} from '../../../studio/src/lib/compose.js';
import {
  REEL_STYLE,
  buildCues,
  captionAt,
  cuesForClip,
  type Cue,
  type Word,
} from '../../../studio/src/lib/subtitles.js';
import { applyPolish, type PolishChange } from '../../../studio/src/lib/polish.js';
import {
  compact,
  emptyTimeline,
  insertAfter,
  reorder,
  rippleDelete,
  splitAt,
  trim,
  validate,
  type Clip,
  type Timeline,
} from '../../../studio/src/lib/timeline.js';
import { cssColour, paintFrame, type Painter2D } from '../../../studio/src/web/paint.js';
import { FrameCache } from '../../../studio/src/web/framecache.js';
import { GopDecoder } from '../../../studio/src/web/decoder.js';
import type { Shot } from '../../../studio/src/lib/store.js';
import type { DirectedReel, DirectedShot } from '../../../studio/src/lib/director.js';
import { loadSource, loadStill, type LoadedSource, type PreviewFrame } from './media.js';
import { PreviewSound, decodeSound, peaksOf, type Voice } from './sound.js';
import { withOverlay } from './layers.js';
import { DEFAULT_CAPTIONS, captionTheme, fade, look, sourceTime as sourceTimeOf, type CaptionStyle } from './effects.js';
import type { Grade } from '../../../studio/src/lib/timeline.js';
import themeDefaults from './theme-defaults.json';
import type { Theme } from '../../../studio/src/domain/workspace.js';

/**
 * The editor, as a hook.
 *
 * ── Why the timeline is React state but the picture is not ───────────
 *
 * The timeline document is small, immutable and changes only when the user
 * does something, which is exactly what React state is for. The preview is
 * a 1080x1920 canvas repainted on every pointer move during a scrub -- which
 * is exactly what React state is not for. So the document lives here and
 * the painting is imperative, against a ref.
 *
 * Trying to drive the canvas through state would mean a reconcile per
 * pointer event for a tree that never changes shape.
 *
 * ── The one correctness rule ─────────────────────────────────────────
 *
 * Every edit goes through a pure operation from `timeline.ts`. None of them
 * is reimplemented here. Those operations have 52 tests and the properties
 * that matter -- a split that does not rewind the footage, a ripple that
 * leaves no gap -- are proven there, once.
 */

/**
 * The face captions are drawn in on the canvas, preview and export alike.
 *
 * One constant, because the preview and the browser export must set the
 * same text or the draft a creator approves is not the file they get. It is
 * the reel's own typography, not this app's chrome.
 */
export const CAPTION_FACE = '"Inter Variable", Inter, system-ui, sans-serif';
const FACE = CAPTION_FACE;
const theme: Theme = themeDefaults;

export interface LoadedClip {
  readonly source: LoadedSource;
  readonly decoder: GopDecoder<PreviewFrame>;
  readonly size: SourceSize;
  /** Cues in SOURCE time, before any trimming. */
  cues: readonly Cue[];
}

export interface EditorStats {
  readonly seeks: number;
  readonly free: number;
  readonly framesDecoded: number;
  readonly resets: number;
  readonly held: number;
}

const clipsOf = (t: Timeline): Clip[] =>
  [...(t.tracks[0]?.clips ?? [])].sort((a, b) => a.start - b.start);

/** The overlay (B-roll) and music tracks. V1 is magnetic; these are free. */
export const OVERLAY = 'v2';
export const MUSIC = 'a1';

/** Clips of one track in time order; a track not yet made is empty. */
export const trackClips = (t: Timeline, id: string): Clip[] =>
  [...(t.tracks.find((x) => x.id === id)?.clips ?? [])].sort((a, b) => a.start - b.start);

const ensureTrack = (t: Timeline, id: string, kind: 'overlay' | 'audio'): Timeline =>
  t.tracks.some((x) => x.id === id) ? t : { ...t, tracks: [...t.tracks, { id, kind, clips: [] }] };

const mapTrack = (t: Timeline, id: string, f: (clips: Clip[]) => Clip[]): Timeline => ({
  ...t,
  tracks: t.tracks.map((x) => (x.id === id ? { ...x, clips: f(x.clips) } : x)),
});

/**
 * A trim on the main track, then the track closed up. The engine's trim is
 * a plain trim -- it moves one clip's edge and nothing else -- so on the
 * magnetic main track every trim must be followed by this, or a shortened
 * clip leaves a black gap and a lengthened one runs over its neighbour.
 */
const rippleTrim = (...args: Parameters<typeof trim>): Timeline => compact(trim(...args), args[1]);

/** A clip anywhere on the timeline, with the track it is on. */
const findClip = (t: Timeline, id: string): { clip: Clip; track: string } | null => {
  for (const tr of t.tracks) {
    const clip = tr.clips.find((c) => c.id === id);
    if (clip) return { clip, track: tr.id };
  }
  return null;
};

/** A new id for a copy of `id`: its family name, and a fresh tail. */
const freshId = (id: string): string => `${id.replace(/(-b|-[a-z0-9]{4}c)+$/, '')}-${Math.random().toString(36).slice(2, 6)}c`;

/** The shortest a clip can be trimmed to on a free track. */
const MIN_CLIP = 0.2;

export type MediaKind = 'photo' | 'clip' | 'audio';
export interface MediaItem {
  readonly name: string;
  readonly kind: MediaKind;
  readonly seconds: number | null;
}

/**
 * The clip a piece of a split clip came from.
 *
 * `splitAt` names the second half after the first with a `-b` suffix, so
 * the original id is the clip's identity across any number of splits.
 * Director captions are keyed by it, and because a split also advances
 * `sourceIn`, each half then shows exactly the words of its own stretch.
 */
const rootOf = (id: string): string => id.replace(/(-b)+$/, '');

/** The running order's account of a directed shot. */
export interface ShotInfo {
  readonly role: DirectedShot['role'];
  /** "Hook", "Scene 2", "Call to action". */
  readonly label: string;
  readonly match: DirectedShot['match'];
  readonly visual: string;
}

const asShot = (c: Clip): Shot => ({
  seconds: c.duration,
  caption: c.caption,
  source: c.source,
});

/**
 * Everything about an edit worth keeping, as saved to the server: the
 * timeline, markers, caption style, the Director's labels and word timings,
 * and the names of the media used. Media itself stays on the machine.
 */
export interface EditDoc {
  readonly version: 1;
  readonly timeline: Timeline;
  readonly markers: readonly number[];
  readonly captionStyle: CaptionStyle;
  readonly media: readonly MediaItem[];
  readonly shots: readonly (readonly [string, ShotInfo])[];
  readonly scripted: readonly (readonly [string, readonly Cue[]])[];
}

export function useEditor(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  options: {
    /** Called with each file once it has loaded, to keep a copy of it. */
    keep?: (file: File) => void;
  } = {},
) {
  const keepRef = useRef(options.keep);
  keepRef.current = options.keep;
  const [timeline, setTimeline] = useState<Timeline>(() => emptyTimeline());

  /**
   * Undo and redo: the timeline before each edit.
   *
   * Recorded from a ref before the edit rather than inside the state
   * updater, because React runs updaters twice in development and a
   * history written from one would double every step. Edits with a key --
   * typing into one caption, one trim drag on one edge -- coalesce within a
   * second, so undo takes back the whole gesture, not one keystroke of it.
   */
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const history = useRef({ past: [] as Timeline[], future: [] as Timeline[], lastKey: '', lastAt: 0 });
  const [, setHistoryTick] = useState(0);
  const record = useCallback((key = '') => {
    const h = history.current;
    const now = Date.now();
    if (key !== '' && key === h.lastKey && now - h.lastAt < 1000) {
      h.lastAt = now;
      return;
    }
    h.past.push(timelineRef.current);
    if (h.past.length > 100) h.past.shift();
    h.future = [];
    h.lastKey = key;
    h.lastAt = now;
    setHistoryTick((t) => t + 1);
  }, []);
  const [playhead, setPlayhead] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  // Ctrl+C holds a clip and the track it came from; Ctrl+V puts a copy back.
  const clipboard = useRef<{ clip: Clip; track: string } | null>(null);
  const [canPaste, setCanPaste] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [stats, setStats] = useState<EditorStats>({
    seeks: 0,
    free: 0,
    framesDecoded: 0,
    resets: 0,
    held: 0,
  });

  // Media is held in refs, not state: a decoded VideoFrame is not a value
  // React should be diffing, and these change without the UI needing to
  // re-render.
  const clips = useRef(new Map<string, LoadedClip>());
  const stills = useRef(new Map<string, { bitmap: ImageBitmap; size: SourceSize }>());

  /**
   * Everything loaded, whether or not it is on the timeline.
   *
   * The Director chooses from this, so a creator can drop twenty clips in
   * and let it decide which goes where, instead of placing each one first.
   */
  const [library, setLibrary] = useState<MediaItem[]>([]);

  /** Each file's decoded sound and its waveform, by file name. */
  const sounds = useRef(new Map<string, { buffer: AudioBuffer; peaks: Float32Array }>());
  const [, setSoundTick] = useState(0);
  const [markers, setMarkers] = useState<number[]>([]);
  /** Shuttle speed: J/K/L. Negative plays backwards, silently. */
  const [rate, setRate] = useState(1);
  const [muted, setMuted] = useState<{ v1: boolean; a1: boolean }>({ v1: false, a1: false });
  const [seekTick, setSeekTick] = useState(0);
  const [captionStyle, setCaptionStyle] = useState<CaptionStyle>(DEFAULT_CAPTIONS);
  const preview = useRef<PreviewSound | null>(null);

  /**
   * Director captions, per clip, in the clip's SOURCE clock.
   *
   * Source clock rather than reel clock so that `cuesForClip` -- the same
   * function that clips a transcript to a trimmed shot -- clips these too.
   * Trimming, splitting and moving a directed shot keeps its words with
   * it, by the code that is already tested for exactly that.
   */
  const scripted = useRef(new Map<string, Cue[]>());

  /**
   * What the Director decided about each shot it placed, and why.
   *
   * Kept beside the clip rather than in it: a `Clip` is the timeline's
   * document and is shared with the server renderer, and "matched on the
   * word reception" is the editor explaining itself, not part of the edit.
   */
  const directedMeta = useRef(new Map<string, ShotInfo>());
  const lastFrame = useRef<PreviewFrame | null>(null);

  // The main track sets the reel's length. Music or an overlay that runs
  // past its end is cut there, not allowed to lengthen the reel.
  const total = clipsOf(timeline).reduce((end, c) => Math.max(end, c.start + c.duration), 0);
  const problems = useMemo(() => validate(timeline), [timeline]);

  /**
   * Every cue, moved onto the finished reel's own clock.
   *
   * A cue's position in the recording is not its position in the reel: the
   * creator trims and reorders. `cuesForClip` does that per clip, which is
   * also what clips any cue that straddles a cut. Recomputed when the
   * timeline changes, which is cheap -- a reel has tens of cues.
   */
  const cues = useMemo<Cue[]>(() => {
    const out: Cue[] = [];
    for (const clip of clipsOf(timeline)) {
      // A directed shot's own narration wins over whatever its footage
      // happens to contain: in a faceless reel the b-roll's audio is not
      // what is being said.
      const own = scripted.current.get(rootOf(clip.id));
      const loaded = clip.source.kind === 'clip' ? clips.current.get(clip.source.path) : undefined;
      const source = own && own.length > 0 ? own : loaded?.cues;
      if (!source || source.length === 0) continue;
      out.push(
        ...cuesForClip(
          source,
          clip.sourceIn * 1000,
          clip.duration * 1000,
          clip.start * 1000,
          REEL_STYLE,
        ),
      );
    }
    return out.sort((a, b) => a.startMs - b.startMs);
  }, [timeline]);

  const cuesRef = useRef(cues);
  cuesRef.current = cues;

  // ---------------------------------------------------------------------
  // Painting.

  const paintAt = useCallback(
    async (time: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return;

      const list = clipsOf(timeline);
      let here: { clip: Clip; index: number; local: number } | null = null;
      for (let i = 0; i < list.length; i += 1) {
        const c = list[i]!;
        if (time >= c.start && time < c.start + c.duration) {
          here = { clip: c, index: i, local: time - c.start };
          break;
        }
      }
      // Past the end, hold the last frame rather than going black -- which
      // is what every editor does and what a creator reviewing expects.
      if (!here && list.length) {
        const last = list[list.length - 1]!;
        here = { clip: last, index: list.length - 1, local: Math.max(0, last.duration - 1 / FRAME_FPS) };
      }
      if (!here) {
        // The reel's own ground, so an empty editor and a text card agree.
        ctx.fillStyle = cssColour(theme.ground);
        ctx.fillRect(0, 0, FRAME_W, FRAME_H);
        return;
      }

      const { clip, index, local } = here;
      const sources = new Map<string, unknown>();
      let size: SourceSize | null = null;

      if (clip.source.kind === 'clip') {
        const loaded = clips.current.get(clip.source.path);
        if (loaded) {
          size = loaded.size;
          const us = Math.round(sourceTimeOf(clip, local) * 1_000_000);
          // Ask the cost before paying it. During a fast drag an expensive
          // seek is skipped and the previous frame held, so the picture
          // stays with the pointer instead of queueing behind it.
          const plan = loaded.decoder.planFor(us);
          const tooDear = !plan.fromCache && loaded.decoder.queued > FRAME_FPS;
          const frame = tooDear ? lastFrame.current : await loaded.decoder.frameAt(us);
          const use = frame ?? lastFrame.current;
          if (use) {
            sources.set(clip.source.path, use.image);
            lastFrame.current = use;
            // The preview frame is a smaller copy of the source (media.ts),
            // so the layout must crop in its pixels, not the file's.
            size = { w: use.image.width, h: use.image.height };
          }
        }
      } else if (clip.source.kind !== 'solid') {
        const still = stills.current.get(clip.source.path);
        if (still) {
          size = still.size;
          sources.set(clip.source.path, still.bitmap);
        }
      }

      // Auto-subtitles win over the shot's scripted caption when a
      // transcript exists, because they are what the creator actually said.
      // An empty string between cues is deliberate: falling back to the
      // scripted line there would flash it up in every gap between words.
      const auto = cuesRef.current.length > 0 ? captionAt(cuesRef.current, time * 1000) : null;

      const styled = captionTheme(theme, captionStyle);
      let spec = look(
        composeFrame({
          shot: asShot(clip),
          index,
          t: local,
          seconds: clip.duration,
          theme: styled,
          source: size,
          ...(auto === null ? {} : { captionOverride: auto }),
        }),
        clip,
        local,
      );

      // B-roll on the overlay track cuts away over the main picture.
      const over = trackClips(timeline, OVERLAY).find((c) => time >= c.start && time < c.start + c.duration);
      if (over && over.source.kind !== 'solid') {
        let overSize: SourceSize | null = null;
        if (over.source.kind === 'clip') {
          const loaded = clips.current.get(over.source.path);
          const frame = loaded ? await loaded.decoder.frameAt(Math.round(sourceTimeOf(over, time - over.start) * 1_000_000)) : null;
          if (loaded && frame) {
            overSize = { w: frame.image.width, h: frame.image.height };
            sources.set(over.source.path, frame.image);
          }
        } else {
          const still = stills.current.get(over.source.path);
          if (still) {
            overSize = still.size;
            sources.set(over.source.path, still.bitmap);
          }
        }
        if (overSize) {
          spec = withOverlay(
            spec,
            look(
              composeFrame({
                shot: { seconds: over.duration, caption: '', source: over.source },
                index: 1,
                t: time - over.start,
                seconds: over.duration,
                theme: styled,
                source: overSize,
                captionOverride: '',
              }),
              over,
              time - over.start,
            ),
          );
        }
      }

      paintFrame(ctx as unknown as Painter2D, fade(spec, clip, local), { fontFamily: FACE, sources });
    },
    [canvasRef, timeline, captionStyle],
  );

  // Coalesced to one paint per animation frame: a pointer drag fires far
  // more often than a screen refreshes, and painting per event is wasted
  // work that makes the drag feel worse, not better.
  const pending = useRef(false);
  const requestPaint = useCallback(
    (time: number) => {
      if (pending.current) return;
      pending.current = true;
      requestAnimationFrame(() => {
        pending.current = false;
        void paintAt(time);
      });
    },
    [paintAt],
  );

  useEffect(() => {
    requestPaint(playhead);
  }, [playhead, timeline, requestPaint]);

  // The decode counters, refreshed on a slow timer. These are the editor's
  // own evidence that scrubbing is cheap, so they are shown, not logged.
  useEffect(() => {
    const id = setInterval(() => {
      let seeks = 0;
      let free = 0;
      let framesDecoded = 0;
      let resets = 0;
      let held = 0;
      for (const { decoder } of clips.current.values()) {
        free += decoder.stats.cacheHits;
        seeks += decoder.stats.cacheHits + decoder.stats.decodes;
        framesDecoded += decoder.stats.framesDecoded;
        resets += decoder.stats.resets;
        held += decoder.cache.size;
      }
      setStats({ seeks, free, framesDecoded, resets, held });
    }, 400);
    return () => clearInterval(id);
  }, []);

  // ---------------------------------------------------------------------
  // Transport.

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      const dt = last ? (now - last) / 1000 : 0;
      last = now;
      setPlayhead((p) => {
        const next = p + dt * rate;
        if (next >= total) {
          setPlaying(false);
          return total;
        }
        if (next <= 0 && rate < 0) {
          setPlaying(false);
          return 0;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, total, rate]);

  /** Every sound on the timeline, as the export and the preview hear it. */
  const voices = useCallback((): Voice[] => {
    const out: Voice[] = [];
    if (!muted.v1) {
      for (const c of clipsOf(timeline)) {
        const s = c.source.kind === 'clip' ? sounds.current.get(c.source.path) : undefined;
        if (s) out.push({ buffer: s.buffer, start: c.start, duration: c.duration, sourceIn: c.sourceIn, gain: c.volume ?? 1, speed: c.speed ?? 1 });
      }
    }
    if (!muted.a1) {
      for (const c of trackClips(timeline, MUSIC)) {
        const s = c.source.kind === 'clip' ? sounds.current.get(c.source.path) : undefined;
        const length = Math.min(c.duration, Math.max(0, total - c.start));
        if (s && length > 0) out.push({ buffer: s.buffer, start: c.start, duration: length, sourceIn: c.sourceIn, gain: c.volume ?? 1 });
      }
    }
    return out;
  }, [timeline, muted, total]);

  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;
  useEffect(() => {
    preview.current ??= new PreviewSound();
    if (!playing) {
      preview.current.stop();
      return;
    }
    preview.current.play(playheadRef.current, voices(), rate);
    return () => preview.current?.stop();
  }, [playing, rate, voices, seekTick]);

  // ---------------------------------------------------------------------
  // Edits. Each one delegates to a tested pure operation.

  const addClip = useCallback((source: Clip['source'], seconds: number, caption: string) => {
    record();
    setTimeline((prev) => {
      const list = clipsOf(prev);
      const lastClip = list[list.length - 1];
      const start = lastClip ? lastClip.start + lastClip.duration : 0;
      const id = `c${list.length + 1}-${Math.random().toString(36).slice(2, 6)}`;
      const clip: Clip = {
        id,
        start,
        duration: seconds,
        sourceIn: source.kind === 'clip' ? source.from : 0,
        caption,
        source,
      };
      setSelected(id);
      return {
        ...prev,
        tracks: prev.tracks.map((tr) =>
          tr.id === 'v1' ? { ...tr, clips: [...tr.clips, clip] } : tr,
        ),
      };
    });
  }, []);

  const actions = useMemo(
    () => ({
      seek: (time: number) => {
        setPlayhead(Math.max(0, Math.min(total, time)));
        setSeekTick((t) => t + 1);
      },
      step: (frames: number) => {
        setPlaying(false);
        setPlayhead((p) => Math.max(0, Math.min(total, p + frames / FRAME_FPS)));
      },
      togglePlay: () => {
        setRate(1);
        setPlaying((v) => !v);
      },
      /** J/K/L: a speed to play at, or 0 to stop. */
      shuttle: (speed: number) => {
        setRate(speed === 0 ? 1 : speed);
        setPlaying(speed !== 0);
      },
      /** M: a marker at the playhead, or remove the one already there. */
      toggleMarker: () =>
        setMarkers((m) =>
          m.some((x) => Math.abs(x - playhead) < 0.05)
            ? m.filter((x) => Math.abs(x - playhead) >= 0.05)
            : [...m, playhead].sort((a, b) => a - b),
        ),
      toggleMute: (track: 'v1' | 'a1') => setMuted((m) => ({ ...m, [track]: !m[track] })),

      /** Cut B-roll in at the playhead, on the overlay track. */
      placeOverlay: (name: string, at: number = playhead) => {
        const still = stills.current.get(name);
        const clip = clips.current.get(name);
        if (!still && !clip) return;
        const span = still ? 3 : Math.min(clip!.source.seconds, 4);
        record();
        const id = `o${Math.random().toString(36).slice(2, 8)}`;
        setTimeline((prev) =>
          mapTrack(ensureTrack(prev, OVERLAY, 'overlay'), OVERLAY, (cs) => [
            ...cs,
            {
              id,
              start: Math.max(0, at),
              duration: span,
              sourceIn: 0,
              caption: '',
              source: still ? { kind: 'photo', path: name } : { kind: 'clip', path: name, from: 0, to: span },
            },
          ]),
        );
        setSelected(id);
      },

      /** Lay a sound file on the music track, from the start or the playhead. */
      placeMusic: (name: string, dropAt?: number) => {
        const s = sounds.current.get(name);
        if (!s) return;
        record();
        const id = `m${Math.random().toString(36).slice(2, 8)}`;
        setTimeline((prev) => {
          const withMusic = ensureTrack(prev, MUSIC, 'audio');
          const at = dropAt !== undefined ? Math.max(0, dropAt) : trackClips(withMusic, MUSIC).length === 0 ? 0 : playhead;
          const span = Math.min(s.buffer.duration, Math.max(total - at, 1));
          return mapTrack(withMusic, MUSIC, (cs) => [
            ...cs,
            { id, start: at, duration: span, sourceIn: 0, caption: '', source: { kind: 'clip', path: name, from: 0, to: span }, volume: 0.6 },
          ]);
        });
        setSelected(id);
      },

      /** Move a clip on a free track. Coalesced, so one drag is one undo. */
      moveFree: (trackId: string, id: string, start: number) => {
        record(`move:${id}`);
        setTimeline((prev) =>
          mapTrack(prev, trackId, (cs) => cs.map((c) => (c.id === id ? { ...c, start: Math.max(0, start) } : c))),
        );
      },

      /** Trim a clip on a free track without moving anything else. */
      trimFree: (trackId: string, id: string, edge: 'in' | 'out', delta: number) => {
        record(`trimf:${id}:${edge}`);
        setTimeline((prev) =>
          mapTrack(prev, trackId, (cs) =>
            cs.map((c) => {
              if (c.id !== id) return c;
              const path = c.source.kind === 'solid' ? null : c.source.path;
              const length =
                path === null
                  ? Infinity
                  : (sounds.current.get(path)?.buffer.duration ??
                    clips.current.get(path)?.source.seconds ??
                    Infinity);
              if (edge === 'in') {
                const d = Math.max(-Math.min(c.start, c.sourceIn), Math.min(delta, c.duration - MIN_CLIP));
                return { ...c, start: c.start + d, sourceIn: c.sourceIn + d, duration: c.duration - d };
              }
              const most = c.source.kind === 'photo' ? Infinity : length - c.sourceIn;
              return { ...c, duration: Math.max(MIN_CLIP, Math.min(most, c.duration + delta)) };
            }),
          ),
        );
      },

      setLook: (id: string, grade: Grade) => {
        record(`look:${id}`);
        setTimeline((prev) => ({
          ...prev,
          tracks: prev.tracks.map((tr) => ({ ...tr, clips: tr.clips.map((c) => (c.id === id ? { ...c, grade } : c)) })),
        }));
      },
      setMotion: (id: string, motion: { zoom?: { from: number; to: number } | null; fadeIn?: number; fadeOut?: number }) => {
        record(`motion:${id}`);
        setTimeline((prev) => ({
          ...prev,
          tracks: prev.tracks.map((tr) => ({
            ...tr,
            clips: tr.clips.map((c) => {
              if (c.id !== id) return c;
              const next = { ...c };
              if (motion.zoom !== undefined) {
                if (motion.zoom === null) delete next.zoom;
                else next.zoom = motion.zoom;
              }
              if (motion.fadeIn !== undefined) next.fadeIn = motion.fadeIn;
              if (motion.fadeOut !== undefined) next.fadeOut = motion.fadeOut;
              return next;
            }),
          })),
        }));
      },
      /**
       * Change a video clip's speed. Its source span is kept, so the clip
       * gets shorter or longer on the timeline -- and on the main track the
       * clips after it move up or along, as they do for any trim.
       */
      setSpeed: (id: string, speed: number) => {
        record();
        setTimeline((prev) => {
          const all = prev.tracks.flatMap((tr) => tr.clips.map((c) => ({ c, track: tr.id })));
          const hit = all.find((x) => x.c.id === id);
          if (!hit || hit.c.source.kind !== 'clip') return prev;
          const old = hit.c.speed ?? 1;
          const seconds = clips.current.get(hit.c.source.path)?.source.seconds ?? Infinity;
          const span = Math.min(hit.c.duration * old, seconds - hit.c.sourceIn);
          const duration = Math.max(MIN_CLIP, span / speed);
          const withSpeed = {
            ...prev,
            tracks: prev.tracks.map((tr) => ({ ...tr, clips: tr.clips.map((c) => (c.id === id ? { ...c, speed } : c)) })),
          };
          if (hit.track !== 'v1') {
            return mapTrack(withSpeed, hit.track, (cs) => cs.map((c) => (c.id === id ? { ...c, duration } : c)));
          }
          return rippleTrim(withSpeed, 'v1', id, 'out', duration - hit.c.duration);
        });
      },
      setCaptionStyle: (style: CaptionStyle) => setCaptionStyle(style),

      setVolume: (id: string, volume: number) => {
        record(`vol:${id}`);
        setTimeline((prev) => ({
          ...prev,
          tracks: prev.tracks.map((tr) => ({ ...tr, clips: tr.clips.map((c) => (c.id === id ? { ...c, volume } : c)) })),
        }));
      },
      select: setSelected,

      split: () => {
        record();
        setTimeline((prev) => splitAt(prev, 'v1', playhead));
      },
      remove: () => {
        if (!selected) return;
        record();
        // The main track closes the gap; a free track just loses the clip.
        setTimeline((prev) =>
          clipsOf(prev).some((c) => c.id === selected)
            ? rippleDelete(prev, 'v1', selected)
            : {
                ...prev,
                tracks: prev.tracks.map((tr) => ({ ...tr, clips: tr.clips.filter((c) => c.id !== selected) })),
              },
        );
        setSelected(null);
      },
      move: (by: number) => {
        if (!selected) return;
        record();
        setTimeline((prev) => {
          const from = clipsOf(prev).findIndex((c) => c.id === selected);
          return from === -1 ? prev : reorder(prev, 'v1', selected, from + by);
        });
      },

      // Ids are made here, outside the updaters: React runs an updater twice
      // in development, and two runs must not invent two different copies.

      /**
       * Open a saved edit. It becomes the starting point: undo does not
       * reach back past it to the empty reel the editor opened with.
       */
      restore: (doc: EditDoc) => {
        directedMeta.current = new Map(doc.shots.map(([id, info]) => [id, info]));
        scripted.current = new Map(doc.scripted.map(([id, cues]) => [id, [...cues]]));
        setTimeline(doc.timeline);
        setMarkers([...doc.markers]);
        setCaptionStyle(doc.captionStyle);
        history.current = { past: [], future: [], lastKey: '', lastAt: 0 };
        setHistoryTick((t) => t + 1);
        setSelected(null);
        setPlayhead(0);
      },

      /** The editor's pass: the chosen changes, as one edit and one undo. */
      polish: (changes: readonly PolishChange[]) => {
        if (changes.length === 0) return;
        record();
        setTimeline((prev) => applyPolish(prev, changes));
      },

      /** Ctrl+D: a copy straight after the original, and selected. */
      duplicate: (id: string | null = selected) => {
        const hit = id ? findClip(timelineRef.current, id) : null;
        if (!id || !hit) return;
        const copy = { ...hit.clip, id: freshId(id) };
        record();
        setTimeline((prev) => {
          if (!findClip(prev, id)) return prev;
          return hit.track === 'v1'
            ? insertAfter(prev, 'v1', id, copy)
            : mapTrack(prev, hit.track, (cs) => [...cs, { ...copy, start: hit.clip.start + hit.clip.duration }]);
        });
        setSelected(copy.id);
      },
      /** Ctrl+C. */
      copy: (id: string | null = selected) => {
        const hit = id ? findClip(timelineRef.current, id) : null;
        if (!hit) return;
        clipboard.current = hit;
        setCanPaste(true);
      },
      /**
       * Ctrl+V: on the main track, after the selected clip (or at the end);
       * on a free track, at the playhead.
       */
      paste: () => {
        const held = clipboard.current;
        if (!held) return;
        const copy = { ...held.clip, id: freshId(held.clip.id) };
        const main = clipsOf(timelineRef.current);
        const anchor = selected && main.some((c) => c.id === selected) ? selected : (main[main.length - 1]?.id ?? null);
        record();
        setTimeline((prev) => {
          if (held.track === 'v1') {
            return anchor === null || clipsOf(prev).some((c) => c.id === anchor) ? insertAfter(prev, 'v1', anchor, copy) : prev;
          }
          const kind = held.track === OVERLAY ? 'overlay' : 'audio';
          return mapTrack(ensureTrack(prev, held.track, kind), held.track, (cs) => [...cs, { ...copy, start: playhead }]);
        });
        setSelected(copy.id);
      },
      /** Back to the clip as imported: no grade, push, fades or speed change. */
      resetEffects: (id: string | null = selected) => {
        const hit = id ? findClip(timelineRef.current, id) : null;
        if (!id || !hit) return;
        const speed = hit.clip.speed ?? 1;
        record();
        setTimeline((prev) => {
          const plain = (c: Clip): Clip => {
            if (c.id !== id) return c;
            const next = { ...c };
            delete next.grade;
            delete next.zoom;
            delete next.fadeIn;
            delete next.fadeOut;
            delete next.speed;
            return next;
          };
          const cleaned = { ...prev, tracks: prev.tracks.map((tr) => ({ ...tr, clips: tr.clips.map(plain) })) };
          if (speed === 1 || hit.clip.source.kind !== 'clip') return cleaned;
          // Undoing a speed change gives the clip back the source time it covered.
          const seconds = clips.current.get(hit.clip.source.path)?.source.seconds ?? Infinity;
          const duration = Math.max(MIN_CLIP, Math.min(hit.clip.duration * speed, seconds - hit.clip.sourceIn));
          if (hit.track !== 'v1') return mapTrack(cleaned, hit.track, (cs) => cs.map((c) => (c.id === id ? { ...c, duration } : c)));
          return rippleTrim(cleaned, 'v1', id, 'out', duration - hit.clip.duration);
        });
      },
      /**
       * Q and W, as in the big editors: cut the selected clip's head or tail
       * back to the playhead. On the main track the rest of the reel closes
       * up behind it.
       */
      trimToPlayhead: (edge: 'in' | 'out') => {
        const hit = selected ? findClip(timelineRef.current, selected) : null;
        if (!selected || !hit) return;
        const { start, duration } = hit.clip;
        if (playhead <= start + MIN_CLIP / 2 || playhead >= start + duration - MIN_CLIP / 2) return;
        const delta = edge === 'in' ? playhead - start : playhead - (start + duration);
        record();
        if (hit.track === 'v1') {
          setTimeline((prev) => rippleTrim(prev, 'v1', selected, edge, delta));
          // The head moved out from under the playhead: follow the cut.
          if (edge === 'in') setPlayhead(start);
        } else {
          setTimeline((prev) => mapTrack(prev, hit.track, (cs) =>
            cs.map((c) =>
              c.id !== selected
                ? c
                : edge === 'in'
                  ? { ...c, start: c.start + delta, sourceIn: c.sourceIn + delta, duration: c.duration - delta }
                  : { ...c, duration: c.duration + delta },
            ),
          ));
        }
      },
      trimBy: (id: string, edge: 'in' | 'out', delta: number) => {
        record(`trim:${id}:${edge}`);
        setTimeline((prev) => {
          const clip = clipsOf(prev).find((c) => c.id === id);
          const seconds =
            clip && clip.source.kind === 'clip'
              ? clips.current.get(clip.source.path)?.source.seconds
              : undefined;
          const speed = clip?.speed ?? 1;
          if (speed === 1 || !clip) {
            return seconds === undefined
              ? rippleTrim(prev, 'v1', id, edge, delta)
              : rippleTrim(prev, 'v1', id, edge, delta, seconds);
          }
          // A sped clip spends source faster than timeline: the trim works in
          // timeline seconds, then the source position is scaled to match.
          const bound = seconds === undefined ? undefined : clip.sourceIn + (seconds - clip.sourceIn) / speed;
          const next = bound === undefined ? rippleTrim(prev, 'v1', id, edge, delta) : rippleTrim(prev, 'v1', id, edge, delta, bound);
          if (edge === 'out') return next;
          return {
            ...next,
            tracks: next.tracks.map((tr) => ({
              ...tr,
              clips: tr.clips.map((c) =>
                c.id === id ? { ...c, sourceIn: Math.max(0, clip.sourceIn + (c.sourceIn - clip.sourceIn) * speed) } : c,
              ),
            })),
          };
        });
      },
      setCaption: (id: string, text: string) => {
        record(`caption:${id}`);
        setTimeline((prev) => ({
          ...prev,
          tracks: prev.tracks.map((tr) => ({
            ...tr,
            clips: tr.clips.map((c) => (c.id === id ? { ...c, caption: text } : c)),
          })),
        }));
      },

      undo: () => {
        const h = history.current;
        const prev = h.past.pop();
        if (!prev) return;
        h.future.push(timelineRef.current);
        h.lastKey = '';
        setTimeline(prev);
        setHistoryTick((t) => t + 1);
      },
      redo: () => {
        const h = history.current;
        const next = h.future.pop();
        if (!next) return;
        h.past.push(timelineRef.current);
        h.lastKey = '';
        setTimeline(next);
        setHistoryTick((t) => t + 1);
      },

      addCard: () => addClip({ kind: 'solid', label: '' }, 3, 'Your line here'),

      /** Append something already in the media library to the timeline. */
      /**
       * Put media on the main track: at the end, or -- dropped by hand -- at
       * the cut nearest to where it was let go.
       */
      place: (name: string, dropAt?: number) => {
        const still = stills.current.get(name);
        const clip = clips.current.get(name);
        if (!still && !clip) return;
        const span = still ? 4 : Math.min(clip!.source.seconds, 6);
        const source: Clip['source'] = still ? { kind: 'photo', path: name } : { kind: 'clip', path: name, from: 0, to: span };
        if (dropAt === undefined) {
          addClip(source, span, '');
          return;
        }
        const main = clipsOf(timelineRef.current);
        const before = main.filter((c) => c.start + c.duration / 2 <= dropAt);
        const anchor = before.length ? before[before.length - 1]!.id : null;
        const id = freshId('c');
        record();
        setTimeline((prev) => insertAfter(prev, 'v1', anchor, { id, duration: span, sourceIn: 0, caption: '', source }));
        setSelected(id);
      },
      /** A main-track clip dragged to a new place in the running order. */
      reorderTo: (id: string, index: number) => {
        const from = clipsOf(timelineRef.current).findIndex((c) => c.id === id);
        if (from === -1 || from === index) return;
        record();
        setTimeline((prev) => (clipsOf(prev).some((c) => c.id === id) ? reorder(prev, 'v1', id, index) : prev));
      },

      /**
       * Replace the timeline with a directed cut.
       *
       * Every shot becomes an ordinary clip -- draggable, trimmable,
       * splittable -- with its words attached in source time. Replacing
       * rather than appending, because a Director run is a fresh draft of
       * the whole reel; the caller confirms before throwing away a cut.
       */
      direct: (reel: DirectedReel) => {
        record();
        scripted.current.clear();
        directedMeta.current.clear();
        let scene = 0;
        let start = 0;
        const placed: Clip[] = reel.shots.map((shot, i) => {
          const id = `d${i + 1}-${Math.random().toString(36).slice(2, 6)}`;
          if (shot.role === 'scene') scene += 1;
          directedMeta.current.set(id, {
            role: shot.role,
            label: shot.role === 'hook' ? 'Hook' : shot.role === 'cta' ? 'Call to action' : `Scene ${scene}`,
            match: shot.match,
            visual: shot.visual,
          });
          const sourceIn = shot.source.kind === 'clip' ? shot.source.from : 0;
          const offsetMs = Math.round(sourceIn * 1000);
          scripted.current.set(
            id,
            buildCues(
              shot.words.map((w) => ({ ...w, startMs: w.startMs + offsetMs, endMs: w.endMs + offsetMs })),
              REEL_STYLE,
            ),
          );
          const clip: Clip = {
            id,
            start,
            duration: shot.seconds,
            sourceIn,
            caption: shot.text,
            source: shot.source,
          };
          start = Math.round((start + shot.seconds) * 1000) / 1000;
          return clip;
        });
        setTimeline((prev) => ({
          ...prev,
          tracks: prev.tracks.map((tr) => (tr.id === 'v1' ? { ...tr, clips: placed } : tr)),
        }));
        setSelected(placed[0]?.id ?? null);
        setPlaying(false);
        setPlayhead(0);
      },

      /** Attach word timings to a loaded clip, which turns on auto-captions. */
      applyWords: (path: string, words: readonly Word[]) => {
        const loaded = clips.current.get(path);
        if (!loaded) return;
        loaded.cues = buildCues(words, REEL_STYLE);
        // The cue list is derived from the timeline, so nudging the
        // timeline identity is what makes it recompute.
        setTimeline((prev) => ({ ...prev, tracks: [...prev.tracks] }));
      },

      /**
       * Load media. `place: false` puts it in the library only, for the
       * Director to choose from; the default keeps the old behaviour of
       * appending each file to the timeline.
       */
      load: async (files: readonly File[], place = true, keep = true) => {
        for (const file of files) {
          const path = file.name;
          try {
            if (file.type.startsWith('audio/')) {
              const buffer = await decodeSound(file);
              if (!buffer) throw new Error('That file has no sound this browser can read.');
              sounds.current.set(path, { buffer, peaks: peaksOf(buffer) });
              setSoundTick((t) => t + 1);
              setLibrary((lib) => [
                ...lib.filter((x) => x.name !== path),
                { name: path, kind: 'audio', seconds: buffer.duration },
              ]);
              if (keep) keepRef.current?.(file);
              continue;
            }
            if (file.type.startsWith('image/')) {
              const { bitmap, width, height } = await loadStill(file);
              // Loading a file of the same name again replaces it, so the
              // old bitmap's memory goes with it.
              stills.current.get(path)?.bitmap.close();
              stills.current.set(path, { bitmap, size: { w: width, h: height } });
              setLibrary((lib) => [
                ...lib.filter((x) => x.name !== path),
                { name: path, kind: 'photo', seconds: null },
              ]);
              if (place) addClip({ kind: 'photo', path }, 4, '');
              if (keep) keepRef.current?.(file);
            } else {
              const source = await loadSource(file);
              const decoder = new GopDecoder<PreviewFrame>(
                source.index,
                source.host,
                // About four seconds of 1080x1920 frames, which keeps a
                // scrub around a cut inside the cache.
                new FrameCache<PreviewFrame>(120),
              );
              clips.current.get(path)?.decoder.close();
              clips.current.set(path, { source, decoder, size: { w: source.width, h: source.height }, cues: [] });
              setLibrary((lib) => [
                ...lib.filter((x) => x.name !== path),
                { name: path, kind: 'clip', seconds: source.seconds },
              ]);
              const span = Math.min(source.seconds, 6);
              if (place) addClip({ kind: 'clip', path, from: 0, to: span }, span, '');
              if (keep) keepRef.current?.(file);
              // The clip's own sound, decoded in the background: the picture
              // is usable before the audio is ready.
              void decodeSound(file)
                .then((buffer) => {
                  if (!buffer) return;
                  sounds.current.set(path, { buffer, peaks: peaksOf(buffer) });
                  setSoundTick((t) => t + 1);
                })
                .catch(() => undefined);
            }
          } catch (err) {
            setNote({ text: `${path}: ${err instanceof Error ? err.message : String(err)}`, bad: true });
          }
        }
      },
    }),
    [playhead, selected, total, addClip, record],
  );

  // Release decoder buffers on the way out. A VideoFrame is not reclaimed
  // by the garbage collector, so leaving the page without this leaks every
  // frame the cache was holding.
  useEffect(
    () => () => {
      for (const { decoder } of clips.current.values()) decoder.close();
      for (const { bitmap } of stills.current.values()) bitmap.close();
      preview.current?.close();
      clips.current.clear();
      stills.current.clear();
    },
    [],
  );

  return {
    timeline,
    clips: clipsOf(timeline),
    playhead,
    selected,
    playing,
    total,
    problems,
    cues,
    stats,
    note,
    dismissNote: () => setNote(null),
    canUndo: history.current.past.length > 0,
    canRedo: history.current.future.length > 0,
    canPaste,
    actions,
    loadedClips: clips,
    stills,
    library,
    overlayClips: trackClips(timeline, OVERLAY),
    musicClips: trackClips(timeline, MUSIC),
    sounds,
    markers,
    rate,
    muted,
    voices,
    captionStyle,
    theme: captionTheme(theme, captionStyle),
    /** The Director's note on a shot, or undefined for one placed by hand. */
    shotInfo: (id: string): ShotInfo | undefined => directedMeta.current.get(rootOf(id)),
    /** The edit as it stands, for saving. */
    snapshot: (): EditDoc => ({
      version: 1,
      timeline,
      markers,
      captionStyle,
      media: library,
      shots: [...directedMeta.current.entries()],
      scripted: [...scripted.current.entries()],
    }),
  };
}

/** Everything the editor hook returns: what the editor screen is built from. */
export type Editor = ReturnType<typeof useEditor>;
