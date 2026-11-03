import {
  FRAME_FPS,
  FRAME_H,
  FRAME_W,
  composeFrame,
  type FrameSpec,
  type SourceSize,
} from '../../src/lib/compose.js';
import { paintFrame, type Painter2D } from '../../src/web/paint.js';
import { FrameCache } from '../../src/web/framecache.js';
import { GopDecoder } from '../../src/web/decoder.js';
import {
  duration as timelineDuration,
  emptyTimeline,
  rippleDelete,
  reorder,
  splitAt,
  trim,
  validate,
  type Clip,
  type Timeline,
} from '../../src/lib/timeline.js';
import type { Theme } from '../../src/domain/workspace.js';
import themeDefaults from './theme-defaults.json';
import type { Shot } from '../../src/lib/store.js';
import { loadSource, loadStill, type LoadedSource } from './media.js';
import { canExport, download, exportTimeline } from './export.js';

/**
 * The editor.
 *
 * ── What is deliberately not here ────────────────────────────────────
 *
 * No framework. The one piece of state that matters is the timeline
 * document, every operation on it is a pure function that returns a new
 * one, and the view is a canvas plus a few hundred bytes of DOM. A
 * reconciler would be managing a tree that does not change: the picture is
 * painted, not diffed.
 *
 * ── Why the statistics are on screen ────────────────────────────────
 *
 * The decode counters in the corner are not a debug panel. The claim this
 * editor rests on is that frame-exact scrubbing over a hardware decoder is
 * affordable because the GOP is the unit that gets cached -- and a claim
 * about performance that a user cannot see is a claim they have to take on
 * trust. Dragging the playhead back and forth and watching the decode
 * count stay still is the demonstration.
 */

/**
 * The house theme, as JSON generated from the schema at build time.
 *
 * Not `Theme.parse({})`: that would pull zod's whole validator into a
 * bundle that validates nothing, for the sake of seven numbers. The
 * generator keeps the schema as the only definition, so these cannot
 * drift from it -- see scripts/emit-theme-defaults.mts.
 *
 * A real workspace's theme arrives from the server and replaces this.
 */
const theme: Theme = themeDefaults;
const FACE = '"Inter", "Segoe UI", system-ui, sans-serif';

// ---------------------------------------------------------------------------
// State. Small enough to hold in one object and read in one glance.

interface Loaded {
  readonly source: LoadedSource;
  readonly decoder: GopDecoder<VideoFrame>;
  readonly size: SourceSize;
  readonly name: string;
}

const state = {
  timeline: emptyTimeline(),
  playhead: 0,
  selected: null as string | null,
  playing: false,
  /** Uploaded footage, by the path the timeline refers to it as. */
  clips: new Map<string, Loaded>(),
  /** Photographs and screenshots, by path. */
  stills: new Map<string, { bitmap: ImageBitmap; size: SourceSize }>(),
  /** Held so a scrub that outruns the decoder shows the last good frame. */
  lastFrame: null as VideoFrame | null,
  exporting: false,
};

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`The page is missing #${id}.`);
  return node as T;
};

const canvas = el<HTMLCanvasElement>('preview');
canvas.width = FRAME_W;
canvas.height = FRAME_H;
const ctx = canvas.getContext('2d', { alpha: false })!;

// ---------------------------------------------------------------------------
// Reading the document.

const clipsOf = (t: Timeline): Clip[] =>
  [...(t.tracks[0]?.clips ?? [])].sort((a, b) => a.start - b.start);

/** Which clip is on screen at an instant, and how far into it. */
function at(t: Timeline, time: number): { clip: Clip; index: number; local: number } | null {
  const list = clipsOf(t);
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i]!;
    if (time >= c.start && time < c.start + c.duration) {
      return { clip: c, index: i, local: time - c.start };
    }
  }
  // Past the end: hold the last frame rather than going black, which is
  // what every editor does and what a creator expects when reviewing.
  const last = list[list.length - 1];
  return last ? { clip: last, index: list.length - 1, local: last.duration - 1 / FRAME_FPS } : null;
}

/** A clip, as the shape the geometry solver takes. */
const asShot = (c: Clip): Shot => ({
  seconds: c.duration,
  caption: c.caption,
  source: c.source,
});

/** The intrinsic size of whatever a clip points at, if it is known yet. */
function sizeOf(c: Clip): SourceSize | null {
  if (c.source.kind === 'solid') return null;
  const path = c.source.path;
  if (c.source.kind === 'clip') return state.clips.get(path)?.size ?? null;
  return state.stills.get(path)?.size ?? null;
}

// ---------------------------------------------------------------------------
// Painting.

let drawPending = false;
/** Coalesced to one paint per animation frame, so a drag cannot queue work. */
function requestDraw(): void {
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(() => {
    drawPending = false;
    void draw();
  });
}

async function draw(): Promise<void> {
  const here = at(state.timeline, state.playhead);
  if (!here) {
    ctx.fillStyle = '#0c0e13';
    ctx.fillRect(0, 0, FRAME_W, FRAME_H);
    renderChrome();
    return;
  }

  const { clip, index, local } = here;
  const spec: FrameSpec = composeFrame({
    shot: asShot(clip),
    index,
    t: local,
    seconds: clip.duration,
    theme,
    source: sizeOf(clip),
  });

  const sources = new Map<string, unknown>();
  if (clip.source.kind === 'clip') {
    const loaded = state.clips.get(clip.source.path);
    if (loaded) {
      const sourceTime = clip.sourceIn + local;
      // Asked for the cost first. During a fast drag an expensive seek is
      // skipped and the previous frame held, which keeps the pointer and
      // the picture together instead of letting the decoder fall behind.
      const plan = loaded.decoder.planFor(Math.round(sourceTime * 1_000_000));
      const expensive = !plan.fromCache && loaded.decoder.queued > FRAME_FPS;
      const frame = expensive
        ? state.lastFrame
        : await loaded.decoder.frameAt(Math.round(sourceTime * 1_000_000));
      const use = frame ?? state.lastFrame;
      if (use) {
        sources.set(clip.source.path, use);
        state.lastFrame = use;
      }
    }
  } else if (clip.source.kind !== 'solid') {
    const still = state.stills.get(clip.source.path);
    if (still) sources.set(clip.source.path, still.bitmap);
  }

  paintFrame(ctx as unknown as Painter2D, spec, { fontFamily: FACE, sources });
  renderChrome();
}

// ---------------------------------------------------------------------------
// The timeline strip.

const strip = el<HTMLDivElement>('strip');

function renderStrip(): void {
  const total = Math.max(0.001, timelineDuration(state.timeline));
  const list = clipsOf(state.timeline);
  strip.innerHTML = '';

  for (const c of list) {
    const node = document.createElement('div');
    node.className = `clip kind-${c.source.kind}${c.id === state.selected ? ' selected' : ''}`;
    node.style.width = `${(c.duration / total) * 100}%`;
    node.dataset.id = c.id;
    const label =
      c.source.kind === 'solid' ? c.source.label || 'card' : c.source.path.split('/').pop()!;
    node.innerHTML =
      `<span class="clip-label">${escapeHtml(label)}</span>` +
      `<span class="clip-time">${c.duration.toFixed(1)}s</span>` +
      `<span class="handle handle-in" data-edge="in"></span>` +
      `<span class="handle handle-out" data-edge="out"></span>`;
    strip.appendChild(node);
  }

  const head = document.createElement('div');
  head.className = 'playhead';
  head.style.left = `${(state.playhead / total) * 100}%`;
  strip.appendChild(head);
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// ---------------------------------------------------------------------------
// The chrome: readouts, inspector, warnings.

function renderChrome(): void {
  const total = timelineDuration(state.timeline);
  el('clock').textContent = `${fmt(state.playhead)} / ${fmt(total)}`;

  // The decode counters, summed across every loaded source.
  let hits = 0;
  let decodes = 0;
  let frames = 0;
  let resets = 0;
  let held = 0;
  for (const { decoder } of state.clips.values()) {
    hits += decoder.stats.cacheHits;
    decodes += decoder.stats.decodes;
    frames += decoder.stats.framesDecoded;
    resets += decoder.stats.resets;
    held += decoder.cache.size;
  }
  const total_seeks = hits + decodes;
  el('stats').innerHTML =
    `<span><b>${total_seeks}</b> seeks</span>` +
    `<span><b>${hits}</b> free</span>` +
    `<span><b>${frames}</b> frames decoded</span>` +
    `<span><b>${resets}</b> resets</span>` +
    `<span><b>${held}</b> held</span>`;

  const problems = validate(state.timeline);
  const warn = el('warn');
  warn.textContent = problems.length
    ? problems.map((p) => `${p.clip}: ${p.what}`).join(' · ')
    : '';
  warn.hidden = problems.length === 0;

  const sel = state.selected
    ? clipsOf(state.timeline).find((c) => c.id === state.selected)
    : undefined;
  const caption = el<HTMLTextAreaElement>('caption');
  if (sel && document.activeElement !== caption) caption.value = sel.caption;
  caption.disabled = !sel;
  el<HTMLButtonElement>('split').disabled = !at(state.timeline, state.playhead);
  el<HTMLButtonElement>('delete').disabled = !sel;
  el<HTMLButtonElement>('left').disabled = !sel;
  el<HTMLButtonElement>('right').disabled = !sel;
}

const fmt = (s: number): string => {
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${String(m).padStart(2, '0')}:${rest.toFixed(2).padStart(5, '0')}`;
};

function rerender(): void {
  renderStrip();
  requestDraw();
}

// ---------------------------------------------------------------------------
// Editing. Every one of these is a pure operation from `timeline.ts`.

el('split').addEventListener('click', () => {
  state.timeline = splitAt(state.timeline, 'v1', state.playhead);
  rerender();
});

el('delete').addEventListener('click', () => {
  if (!state.selected) return;
  state.timeline = rippleDelete(state.timeline, 'v1', state.selected);
  state.selected = null;
  state.playhead = Math.min(state.playhead, timelineDuration(state.timeline));
  rerender();
});

const move = (by: number) => () => {
  if (!state.selected) return;
  const list = clipsOf(state.timeline);
  const from = list.findIndex((c) => c.id === state.selected);
  if (from === -1) return;
  state.timeline = reorder(state.timeline, 'v1', state.selected, from + by);
  rerender();
};
el('left').addEventListener('click', move(-1));
el('right').addEventListener('click', move(1));

el<HTMLTextAreaElement>('caption').addEventListener('input', (e) => {
  if (!state.selected) return;
  const text = (e.target as HTMLTextAreaElement).value;
  // The caption is the one field edited in place rather than through a
  // pure operation: it changes no geometry, so there is nothing to ripple.
  state.timeline = {
    ...state.timeline,
    tracks: state.timeline.tracks.map((tr) => ({
      ...tr,
      clips: tr.clips.map((c) => (c.id === state.selected ? { ...c, caption: text } : c)),
    })),
  };
  rerender();
});

// ---------------------------------------------------------------------------
// Scrubbing and trimming.

let drag: { kind: 'scrub' } | { kind: 'trim'; id: string; edge: 'in' | 'out'; x: number } | null =
  null;

const timeFromX = (clientX: number): number => {
  const box = strip.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (clientX - box.left) / box.width));
  return frac * timelineDuration(state.timeline);
};

strip.addEventListener('pointerdown', (e) => {
  const target = e.target as HTMLElement;
  const handle = target.closest('.handle') as HTMLElement | null;
  const clip = target.closest('.clip') as HTMLElement | null;

  if (handle && clip) {
    drag = {
      kind: 'trim',
      id: clip.dataset.id!,
      edge: handle.dataset.edge as 'in' | 'out',
      x: e.clientX,
    };
    state.selected = clip.dataset.id!;
  } else {
    if (clip) state.selected = clip.dataset.id!;
    drag = { kind: 'scrub' };
    state.playhead = timeFromX(e.clientX);
  }
  strip.setPointerCapture(e.pointerId);
  rerender();
});

strip.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (drag.kind === 'scrub') {
    state.playhead = timeFromX(e.clientX);
    rerender();
    return;
  }
  // Bound once, so the narrowing holds for the rest of the handler. Reading
  // `drag` again after an await or a branch is how this kind of code ends
  // up trimming whichever clip was grabbed second.
  const t = drag;
  const box = strip.getBoundingClientRect();
  const perPx = timelineDuration(state.timeline) / box.width;
  const delta = (e.clientX - t.x) * perPx;
  // Below a frame there is nothing to show, and trimming by sub-frame
  // amounts accumulates rounding across a drag.
  if (Math.abs(delta) < 1 / FRAME_FPS) return;

  const clip = clipsOf(state.timeline).find((c) => c.id === t.id);
  // A clip cannot be trimmed past the end of the footage it points at, and
  // only the loaded source knows where that is.
  const sourceSeconds =
    clip && clip.source.kind === 'clip'
      ? state.clips.get(clip.source.path)?.source.seconds
      : undefined;
  state.timeline =
    sourceSeconds === undefined
      ? trim(state.timeline, 'v1', t.id, t.edge, delta)
      : trim(state.timeline, 'v1', t.id, t.edge, delta, sourceSeconds);
  t.x = e.clientX;
  rerender();
});

const endDrag = (e: PointerEvent) => {
  if (!drag) return;
  drag = null;
  try {
    strip.releasePointerCapture(e.pointerId);
  } catch {
    /* already released */
  }
  rerender();
};
strip.addEventListener('pointerup', endDrag);
strip.addEventListener('pointercancel', endDrag);

// ---------------------------------------------------------------------------
// Transport.

let raf = 0;
let lastTick = 0;
function tick(now: number): void {
  if (!state.playing) return;
  const dt = lastTick ? (now - lastTick) / 1000 : 0;
  lastTick = now;
  state.playhead += dt;
  const total = timelineDuration(state.timeline);
  if (state.playhead >= total) {
    state.playhead = total;
    setPlaying(false);
    return;
  }
  renderStrip();
  void draw();
  raf = requestAnimationFrame(tick);
}

function setPlaying(on: boolean): void {
  state.playing = on;
  el('play').textContent = on ? 'Pause' : 'Play';
  if (on) {
    lastTick = 0;
    raf = requestAnimationFrame(tick);
  } else {
    cancelAnimationFrame(raf);
  }
}
el('play').addEventListener('click', () => setPlaying(!state.playing));

const step = (frames: number) => () => {
  setPlaying(false);
  state.playhead = Math.max(
    0,
    Math.min(timelineDuration(state.timeline), state.playhead + frames / FRAME_FPS),
  );
  rerender();
};
el('back').addEventListener('click', step(-1));
el('fwd').addEventListener('click', step(1));

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
  if (e.key === ' ') {
    e.preventDefault();
    setPlaying(!state.playing);
  } else if (e.key === 'ArrowLeft') step(e.shiftKey ? -FRAME_FPS : -1)();
  else if (e.key === 'ArrowRight') step(e.shiftKey ? FRAME_FPS : 1)();
  else if (e.key === 's') el('split').click();
  else if (e.key === 'Delete' || e.key === 'Backspace') el('delete').click();
});

// ---------------------------------------------------------------------------
// Loading media.

const note = (text: string, bad = false): void => {
  const n = el('note');
  n.textContent = text;
  n.className = bad ? 'note bad' : 'note';
  n.hidden = false;
};

el<HTMLInputElement>('open').addEventListener('change', async (e) => {
  const files = [...((e.target as HTMLInputElement).files ?? [])];
  if (files.length === 0) return;
  note(`Reading ${files.length} file${files.length > 1 ? 's' : ''}…`);

  for (const file of files) {
    const path = file.name;
    try {
      if (file.type.startsWith('image/')) {
        const { bitmap, width, height } = await loadStill(file);
        state.stills.set(path, { bitmap, size: { w: width, h: height } });
        appendClip({ kind: 'photo', path }, 4, path.replace(/\.[^.]+$/, ''));
      } else {
        const source = await loadSource(file);
        const decoder = new GopDecoder<VideoFrame>(
          source.index,
          source.host,
          // 120 frames of 1080x1920 is roughly 350MB of decoder buffers --
          // about four seconds, which keeps a scrub around a cut in cache.
          new FrameCache<VideoFrame>(120),
        );
        state.clips.set(path, {
          source,
          decoder,
          size: { w: source.width, h: source.height },
          name: path,
        });
        const span = Math.min(source.seconds, 6);
        appendClip({ kind: 'clip', path, from: 0, to: span }, span, '');
        note(
          `${path}: ${source.width}×${source.height}, ` +
            `${source.seconds.toFixed(1)}s, ${source.index.gops.length} GOPs, ` +
            `${source.codecString}`,
        );
      }
    } catch (err) {
      note(`${path}: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }
  rerender();
});

let nextId = 1;
function appendClip(source: Clip['source'], seconds: number, caption: string): void {
  const list = clipsOf(state.timeline);
  const start = list.length ? list[list.length - 1]!.start + list[list.length - 1]!.duration : 0;
  const clip: Clip = {
    id: `c${nextId++}`,
    start,
    duration: seconds,
    sourceIn: source.kind === 'clip' ? source.from : 0,
    caption,
    source,
  };
  state.timeline = {
    ...state.timeline,
    tracks: state.timeline.tracks.map((tr) =>
      tr.id === 'v1' ? { ...tr, clips: [...tr.clips, clip] } : tr,
    ),
  };
  state.selected = clip.id;
}

el('addcard').addEventListener('click', () => {
  appendClip({ kind: 'solid', label: 'A TITLE CARD' }, 3, 'Your line here');
  rerender();
});

// ---------------------------------------------------------------------------
// Export.

el('export').addEventListener('click', async () => {
  if (state.exporting) return;
  const check = await canExport();
  if (!check.ok) {
    note(check.why, true);
    return;
  }
  const total = timelineDuration(state.timeline);
  const totalFrames = Math.round(total * FRAME_FPS);
  if (totalFrames === 0) {
    note('There is nothing on the timeline yet.', true);
    return;
  }

  state.exporting = true;
  setPlaying(false);
  el<HTMLButtonElement>('export').disabled = true;
  note(`Encoding ${totalFrames} frames…`);

  try {
    // Built as a generator so only one frame's sources are alive at a time.
    const frames = (function* () {
      for (let f = 0; f < totalFrames; f += 1) {
        const time = f / FRAME_FPS;
        const here = at(state.timeline, time);
        if (!here) continue;
        const sources = new Map<string, unknown>();
        const { clip, index, local } = here;
        if (clip.source.kind !== 'solid' && clip.source.kind !== 'clip') {
          const still = state.stills.get(clip.source.path);
          if (still) sources.set(clip.source.path, still.bitmap);
        }
        yield {
          spec: composeFrame({
            shot: asShot(clip),
            index,
            t: local,
            seconds: clip.duration,
            theme,
            source: sizeOf(clip),
          }),
          sources,
        };
      }
    })();

    const result = await exportTimeline({
      frames,
      totalFrames,
      fontFamily: FACE,
      onProgress: (p) =>
        note(`Encoding… ${p.frame} of ${p.totalFrames} frames (${p.seconds.toFixed(1)}s)`),
    });
    download(result.blob, 'studio-draft.mp4');
    note(
      `Draft written: ${result.frames} frames, ${result.seconds.toFixed(1)}s, ` +
        `${(result.blob.size / 1e6).toFixed(1)}MB. This draft is SILENT — ` +
        'the server export carries your voice.',
    );
  } catch (err) {
    note(`Export failed: ${err instanceof Error ? err.message : String(err)}`, true);
  } finally {
    state.exporting = false;
    el<HTMLButtonElement>('export').disabled = false;
  }
});

// ---------------------------------------------------------------------------
// First run.

appendClip({ kind: 'solid', label: 'A TITLE CARD' }, 3, 'Open a video to begin');
appendClip({ kind: 'solid', label: '' }, 3, 'Drag the playhead. Press S to split.');
state.selected = null;
rerender();
void canExport().then((c) => {
  if (!c.ok) note(c.why, true);
});
