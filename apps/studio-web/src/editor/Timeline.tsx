import { Bookmark, Captions, Film, Layers, Music, Scissors, Trash2, Volume2, VolumeX, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FRAME_FPS } from '../../../studio/src/lib/compose.js';
import type { Clip } from '../../../studio/src/lib/timeline.js';
import { useContextMenu, useLongPress, type MenuEntry } from '../components/ContextMenu';
import { IconButton, cx } from '../components/ui';
import { Waveform } from './MediaBin';
import { clipMenu, timelineMenu } from './menus';
import { ClipThumb, KIND_BG } from './thumbs';
import { formatClock, formatTimecode } from './time';
import { MUSIC, OVERLAY, type Editor } from './useEditor';

/**
 * The timeline: overlay, main video, captions and music on one clock.
 *
 *   V2 Overlay  B-roll that cuts away over the main picture. Free: clips
 *               are dragged anywhere and trimmed without moving others.
 *   V1 Video    the reel itself. Magnetic: trimming or deleting closes
 *               the gap, so the reel never has a hole in it.
 *   Captions    every cue where it falls, so a cue crossing a cut shows.
 *   A1 Music    sound under the reel, free like V2, with its waveform.
 *
 * Zoom widens the content and the view scrolls; while playing, the view
 * keeps the playhead in sight. Dragged clips snap to the playhead, the
 * markers and every clip edge within a few pixels.
 */

const SNAP_PX = 8;
const ZOOMS = [1, 1.5, 2, 3, 4, 6, 8] as const;

/** A ruler step that gives a readable number of labels at this width. */
function stepFor(total: number, widthPx: number): number {
  const target = Math.max(4, Math.floor(widthPx / 90));
  for (const s of [0.5, 1, 2, 5, 10, 15, 30, 60]) if (total / s <= target) return s;
  return 120;
}

type Drag =
  | { kind: 'scrub' }
  | { kind: 'trim'; track: string; id: string; edge: 'in' | 'out'; x: number }
  | { kind: 'move'; track: string; id: string; x: number; origin: number; length: number }
  /** A main-track clip pressed: a click if it stays put, a reorder if it travels. */
  | { kind: 'press'; id: string; x: number }
  | { kind: 'reorder'; id: string }
  /** A finger on empty track space: pans a zoomed timeline; a tap seeks. */
  | { kind: 'pan'; x: number; left: number; moved: boolean }
  | { kind: 'pinch'; from: number; zoom: number };

function Header({ icon, label, height, children }: { icon: ReactNode; label: string; height: string; children?: ReactNode }) {
  return (
    <div className={cx('flex items-center gap-2 border-t border-line px-3 text-xs font-medium text-ink-2 first:border-t-0', height)}>
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {children}
    </div>
  );
}

export function Timeline({ ed }: { ed: Editor }) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const strip = useRef<HTMLDivElement | null>(null);
  const drag = useRef<Drag | null>(null);
  const [insertAt, setInsertAt] = useState<{ id: string; index: number; time: number } | null>(null);
  const fingers = useRef(new Map<number, number>());
  const [zoom, setZoom] = useState(0);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Ctrl+scroll zooms, as in every editor. A native listener, because
  // React's wheel handler is passive and cannot stop the page zooming.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom((z) => Math.max(0, Math.min(ZOOMS.length - 1, z + (e.deltaY < 0 ? 1 : -1))));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // = and − zoom, Shift+Z fits the whole reel, as in the desktop editors.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement || t instanceof HTMLSelectElement) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '=' || e.key === '+') setZoom((z) => Math.min(ZOOMS.length - 1, z + 1));
      else if (e.key === '-' || e.key === '_') setZoom((z) => Math.max(0, z - 1));
      else if (e.key === 'Z' && e.shiftKey) setZoom(0);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Right-click and long-press menus. Entries reach the editor through a
  // ref, so they act on the state at the moment they are chosen.
  const openMenu = useContextMenu();
  const edRef = useRef(ed);
  edRef.current = ed;
  const get = () => edRef.current;
  const menuFor = (target: EventTarget | null): MenuEntry[] => {
    const el = target instanceof Element ? (target.closest('[data-clip]') as HTMLElement | null) : null;
    const id = el?.dataset.clip;
    if (id) {
      ed.actions.select(id);
      return clipMenu(get, id);
    }
    return timelineMenu(get, {
      in: () => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1)),
      out: () => setZoom((z) => Math.max(0, z - 1)),
      fit: () => setZoom(0),
      canIn: zoom < ZOOMS.length - 1,
      canOut: zoom > 0,
    });
  };
  // Which input opened the menu. Browsers give a keyboard-opened menu the
  // focused element's position rather than none, so the only reliable sign
  // of a mouse is a right-button press just before it.
  const lastDown = useRef({ at: 0, type: '', right: false });
  const onContextMenu = (e: React.MouseEvent) => {
    const since = performance.now() - lastDown.current.at;
    // Android fires its own contextmenu after a long press; ours has
    // already opened the menu for what was pressed.
    if (since < 1500 && lastDown.current.type === 'touch') {
      e.preventDefault();
      return;
    }
    const recent = since < 1500 && lastDown.current.right;
    const onClip = e.target instanceof Element && e.target.closest('[data-clip]');
    // From the keyboard (Shift+F10, the menu key) the menu is for the
    // selected clip, if there is one.
    const entries = !onClip && !recent && ed.selected ? clipMenu(get, ed.selected) : menuFor(e.target);
    openMenu(e, entries, 'Timeline actions');
  };
  const press = useLongPress((at, target) => {
    // A long press is a menu, not the start of a scrub or a move.
    drag.current = null;
    openMenu(at, menuFor(target), 'Timeline actions');
  });

  const span = Math.max(ed.total, 0.001);
  const pct = (seconds: number) => `${(seconds / span) * 100}%`;
  const pxOf = (seconds: number) => (seconds / span) * width;

  // Keep the playhead in view while it plays.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !ed.playing || zoom === 0) return;
    const x = pxOf(ed.playhead);
    if (x < el.scrollLeft + 40 || x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = x - el.clientWidth * 0.3;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ed.playhead, ed.playing, zoom]);

  const timeFromX = (clientX: number): number => {
    const box = strip.current?.getBoundingClientRect();
    if (!box || box.width === 0) return 0;
    return Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * ed.total;
  };

  /** Every edge worth snapping to, except the dragged clip's own. */
  const snapTargets = (except: string): number[] => {
    const out = [0, ed.total, ed.playhead, ...ed.markers];
    for (const c of [...ed.clips, ...ed.overlayClips, ...ed.musicClips]) {
      if (c.id === except) continue;
      out.push(c.start, c.start + c.duration);
    }
    return out;
  };
  const snap = (start: number, length: number, except: string): number => {
    const limit = (SNAP_PX * span) / Math.max(1, width);
    let best = start;
    let bestGap = limit;
    for (const t of snapTargets(except)) {
      for (const [edge, offset] of [[start, 0], [start + length, length]] as const) {
        const gap = Math.abs(edge - t);
        if (gap < bestGap) {
          bestGap = gap;
          best = t - offset;
        }
      }
    }
    return Math.max(0, best);
  };

  // Capture can fail when the pointer is already gone -- a touch the browser
  // cancelled mid-gesture -- and a throw here would abandon the gesture.
  const capture = (e: React.PointerEvent) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is no longer active; nothing to hold */
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    lastDown.current = { at: performance.now(), type: e.pointerType, right: e.button === 2 };
    press.handlers.onPointerDown(e);
    const target = e.target as HTMLElement;
    const handle = target.closest('[data-edge]') as HTMLElement | null;
    const clipEl = target.closest('[data-clip]') as HTMLElement | null;
    const marker = target.closest('[data-marker]') as HTMLElement | null;
    // The right button selects and leaves the menu to `contextmenu`; it
    // must not also scrub the playhead to where the menu was opened.
    if (e.button === 2) {
      if (clipEl) ed.actions.select(clipEl.dataset.clip!);
      return;
    }
    if (marker) {
      ed.actions.seek(Number(marker.dataset.marker));
      return;
    }
    if (e.pointerType === 'touch') {
      fingers.current.set(e.pointerId, e.clientX);
      // A second finger turns whatever the first was doing into a pinch.
      if (fingers.current.size === 2) {
        const [a, b] = [...fingers.current.values()];
        drag.current = { kind: 'pinch', from: Math.abs(a! - b!), zoom };
        capture(e);
        return;
      }
      if (!clipEl && !target.closest('[data-ruler]')) {
        drag.current = { kind: 'pan', x: e.clientX, left: scroller.current?.scrollLeft ?? 0, moved: false };
        capture(e);
        return;
      }
    }
    if (clipEl) {
      const id = clipEl.dataset.clip!;
      const track = clipEl.dataset.track!;
      ed.actions.select(id);
      if (handle) {
        drag.current = { kind: 'trim', track, id, edge: handle.dataset.edge as 'in' | 'out', x: e.clientX };
      } else if (track !== 'v1') {
        const clip = [...ed.overlayClips, ...ed.musicClips].find((c) => c.id === id)!;
        drag.current = { kind: 'move', track, id, x: e.clientX, origin: clip.start, length: clip.duration };
      } else {
        // Pressed: seek and select now, as a click does; if the pointer
        // then travels, the clip is being moved along the running order.
        drag.current = { kind: 'press', id, x: e.clientX };
        ed.actions.seek(timeFromX(e.clientX));
      }
    } else {
      drag.current = { kind: 'scrub' };
      ed.actions.seek(timeFromX(e.clientX));
    }
    capture(e);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    press.handlers.onPointerMove(e);
    const d = drag.current;
    if (e.pointerType === 'touch' && fingers.current.has(e.pointerId)) fingers.current.set(e.pointerId, e.clientX);
    if (!d) return;
    if (d.kind === 'scrub') {
      ed.actions.seek(timeFromX(e.clientX));
      return;
    }
    if (d.kind === 'pinch') {
      const [a, b] = [...fingers.current.values()];
      if (a === undefined || b === undefined || d.from < 10) return;
      const want = (ZOOMS[d.zoom] ?? 1) * (Math.abs(a - b) / d.from);
      let best = 0;
      ZOOMS.forEach((z, i) => {
        if (Math.abs(z - want) < Math.abs((ZOOMS[best] ?? 1) - want)) best = i;
      });
      setZoom(best);
      return;
    }
    if (d.kind === 'pan') {
      const dx = e.clientX - d.x;
      if (Math.abs(dx) > 6) d.moved = true;
      if (scroller.current) scroller.current.scrollLeft = d.left - dx;
      return;
    }
    if (d.kind === 'press') {
      if (Math.abs(e.clientX - d.x) < 8) return;
      drag.current = { kind: 'reorder', id: d.id };
    }
    if (drag.current?.kind === 'reorder') {
      const id = drag.current.id;
      const time = timeFromX(e.clientX);
      const others = ed.clips.filter((c) => c.id !== id);
      const index = others.filter((c) => c.start + c.duration / 2 < time).length;
      const at = others[index];
      const boundary = at ? at.start : others.length ? others[others.length - 1]!.start + others[others.length - 1]!.duration : 0;
      setInsertAt({ id, index, time: boundary });
      return;
    }
    if (d.kind !== 'trim' && d.kind !== 'move') return;
    const box = strip.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const delta = ((e.clientX - d.x) * ed.total) / box.width;
    if (d.kind === 'move') {
      ed.actions.moveFree(d.track, d.id, snap(d.origin + delta, d.length, d.id));
      return;
    }
    // Below a frame there is nothing to show, and trimming by sub-frame
    // amounts accumulates rounding across a long drag.
    if (Math.abs(delta) < 1 / FRAME_FPS) return;
    if (d.track === 'v1') ed.actions.trimBy(d.id, d.edge, delta);
    else ed.actions.trimFree(d.track, d.id, d.edge, delta);
    d.x = e.clientX;
  };

  const endDrag = (e: React.PointerEvent) => {
    press.handlers.onPointerUp();
    fingers.current.delete(e.pointerId);
    const d = drag.current;
    if (d?.kind === 'reorder' && insertAt && e.type === 'pointerup') ed.actions.reorderTo(insertAt.id, insertAt.index);
    if (d?.kind === 'pan' && !d.moved && e.type === 'pointerup') ed.actions.seek(timeFromX(e.clientX));
    setInsertAt(null);
    // The pinch ends with its last finger, not its first.
    if (d?.kind === 'pinch' && fingers.current.size > 0) return;
    drag.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  const step = stepFor(ed.total, width);
  const ticks: number[] = [];
  for (let t = 0; t <= ed.total + 1e-6; t += step) ticks.push(t);
  const nowMs = ed.playhead * 1000;

  const edges = (
    <>
      {/* 10px handles: a 3px one is the classic reason trimming feels broken. */}
      <span data-edge="in" aria-hidden="true" className="absolute inset-y-0 left-0 w-2.5 cursor-ew-resize hover:bg-white/25" />
      <span data-edge="out" aria-hidden="true" className="absolute inset-y-0 right-0 w-2.5 cursor-ew-resize hover:bg-white/25" />
    </>
  );

  const freeClip = (c: Clip, track: string, body: ReactNode, bg: string) => {
    // Past the end of the reel it is not heard or seen, so it is not drawn.
    if (c.start >= ed.total) return null;
    const selected = c.id === ed.selected;
    const offline = c.source.kind !== 'solid' && 'path' in c.source && !ed.library.some((m) => m.name === (c.source as { path: string }).path);
    return (
      <div
        key={c.id}
        data-clip={c.id}
        data-track={track}
        title={`${c.source.kind === 'solid' ? 'Card' : c.source.path} · ${formatClock(c.start)} · ${c.duration.toFixed(1)}s`}
        className={cx(
          'absolute inset-y-1 cursor-grab overflow-hidden rounded-md text-white active:cursor-grabbing',
          bg,
          selected ? 'ring-2 ring-inset ring-ink' : 'ring-1 ring-inset ring-black/25',
        )}
        style={{ left: pct(c.start), width: `calc(${pct(Math.min(c.duration, ed.total - c.start))} - 2px)` }}
      >
        {body}
        {offline && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[repeating-linear-gradient(135deg,rgb(var(--bad)/0.55)_0_6px,rgb(var(--bad)/0.35)_6px_12px)] text-2xs font-semibold text-white" title="Media offline: import the file again to relink">
            Offline
          </span>
        )}
        {edges}
      </div>
    );
  };

  return (
    <section aria-label="Timeline" className="flex shrink-0 flex-col border-t border-line bg-panel">
      <div className="flex h-10 items-center gap-1 border-b border-line px-2">
        <IconButton small label="Split at playhead (S)" onClick={ed.actions.split} disabled={ed.clips.length === 0}>
          <Scissors aria-hidden="true" className="h-4 w-4" />
        </IconButton>
        <IconButton small label="Delete selected (Delete)" disabled={!ed.selected} onClick={ed.actions.remove}>
          <Trash2 aria-hidden="true" className="h-4 w-4" />
        </IconButton>
        <IconButton small label="Marker at playhead (M)" onClick={ed.actions.toggleMarker} disabled={ed.total === 0}>
          <Bookmark aria-hidden="true" className="h-4 w-4" />
        </IconButton>
        <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />
        <IconButton small label="Zoom out (−, Ctrl+scroll)" disabled={zoom === 0} onClick={() => setZoom((z) => Math.max(0, z - 1))}>
          <ZoomOut aria-hidden="true" className="h-4 w-4" />
        </IconButton>
        <input
          type="range"
          min={0}
          max={ZOOMS.length - 1}
          step={1}
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          aria-label="Timeline zoom"
          className="hidden w-20 accent-[rgb(var(--ink-3))] sm:block"
        />
        <IconButton small label="Zoom in (=, Ctrl+scroll)" disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))}>
          <ZoomIn aria-hidden="true" className="h-4 w-4" />
        </IconButton>
        {ed.rate !== 1 && ed.playing && (
          <span className="ml-2 rounded bg-panel-3 px-1.5 text-2xs font-semibold text-ink-2">{ed.rate > 0 ? `${ed.rate}×` : `◀ ${-ed.rate}×`}</span>
        )}
        <span className="flex-1" />
        <span className="tabular text-xs text-ink-2">
          <time>{formatTimecode(ed.playhead, FRAME_FPS)}</time>
          <span className="text-ink-3"> / {formatTimecode(ed.total, FRAME_FPS)}</span>
        </span>
      </div>

      <div className="flex">
        {/* Track headers */}
        <div className="w-28 shrink-0 border-r border-line sm:w-32">
          <div className="h-6 border-b border-line" />
          <Header icon={<Layers aria-hidden="true" className="h-3.5 w-3.5" />} label="Overlay" height="h-12" />
          <Header icon={<Film aria-hidden="true" className="h-3.5 w-3.5" />} label="Video" height="h-16">
            <IconButton small label={ed.muted.v1 ? 'Unmute video sound' : 'Mute video sound'} onClick={() => ed.actions.toggleMute('v1')}>
              {ed.muted.v1 ? <VolumeX aria-hidden="true" className="h-3.5 w-3.5" /> : <Volume2 aria-hidden="true" className="h-3.5 w-3.5" />}
            </IconButton>
          </Header>
          <Header icon={<Captions aria-hidden="true" className="h-3.5 w-3.5" />} label="Captions" height="h-9" />
          <Header icon={<Music aria-hidden="true" className="h-3.5 w-3.5" />} label="Music" height="h-12">
            <IconButton small label={ed.muted.a1 ? 'Unmute music' : 'Mute music'} onClick={() => ed.actions.toggleMute('a1')}>
              {ed.muted.a1 ? <VolumeX aria-hidden="true" className="h-3.5 w-3.5" /> : <Volume2 aria-hidden="true" className="h-3.5 w-3.5" />}
            </IconButton>
          </Header>
        </div>

        <div ref={scroller} className="min-w-0 flex-1 overflow-x-auto">
          <div className="px-2" style={{ width: `${(ZOOMS[zoom] ?? 1) * 100}%`, minWidth: '100%' }}>
            <div
              ref={strip}
              data-strip=""
              data-total={ed.total}
              role="group"
              tabIndex={0}
              aria-label="Timeline: drag the ruler to scrub, drag a clip to move it, drag a clip's edge to trim. Shift+F10 for actions."
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onContextMenu={onContextMenu}
              className="relative select-none outline-none [-webkit-touch-callout:none] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-select"
              style={{ touchAction: 'none' }}
            >
              {/* Ruler, with markers. Clipped, so the last label cannot widen the page. */}
              <div data-ruler="" className="relative h-6 cursor-col-resize overflow-hidden border-b border-line">
                {ticks.map((t) => (
                  <span key={t} className="tabular absolute bottom-0 h-2.5 border-l border-line-strong" style={{ left: pct(t) }}>
                    <span className="absolute -top-3.5 left-1 whitespace-nowrap text-2xs text-ink-3">
                      {formatClock(t).replace(/\.0$/, '')}
                    </span>
                  </span>
                ))}
                {ed.markers.map((m) => (
                  <button
                    key={m}
                    type="button"
                    data-marker={m}
                    aria-label={`Marker at ${formatClock(m)}`}
                    title={`Marker · ${formatClock(m)}`}
                    className="absolute top-0 h-full w-3 -translate-x-1/2"
                    style={{ left: pct(m) }}
                  >
                    <span className="mx-auto block h-2.5 w-2.5 rotate-45 rounded-[1px] bg-cue" />
                  </button>
                ))}
              </div>

              {/* V2 overlay */}
              <div data-drop={OVERLAY} className="relative h-12 data-[drop-active]:bg-select/10 data-[drop-active]:ring-2 data-[drop-active]:ring-inset data-[drop-active]:ring-select">
                {ed.overlayClips.map((c) =>
                  freeClip(
                    c,
                    OVERLAY,
                    <span className="flex h-full items-stretch">
                      <ClipThumb clip={c} ed={ed} className="h-full w-7 rounded-none opacity-90" />
                      {pxOf(c.duration) >= 56 && (
                        <span className="flex min-w-0 flex-col justify-center px-2">
                          <span className="truncate text-xs font-semibold">{c.source.kind === 'solid' ? 'Card' : c.source.path}</span>
                          <span className="tabular text-2xs text-white/75">{c.duration.toFixed(1)}s</span>
                        </span>
                      )}
                    </span>,
                    'bg-kind-asset',
                  ),
                )}
              </div>

              {/* V1 video, magnetic */}
              <div data-drop="v1" className="relative flex h-16 items-center border-t border-line py-1.5 data-[drop-active]:bg-select/10 data-[drop-active]:ring-2 data-[drop-active]:ring-inset data-[drop-active]:ring-select">
                {insertAt && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 z-10 w-0.5 -translate-x-1/2 rounded-full bg-select"
                    style={{ left: pct(insertAt.time) }}
                  />
                )}
                {ed.clips.length === 0 && <span className="pl-1 text-xs text-ink-3">Media you add to the timeline appears here</span>}
                {ed.clips.map((c) => {
                  // Media the saved edit names that is not on this computer.
                  const offline = c.source.kind !== 'solid' && 'path' in c.source && !ed.library.some((m) => m.name === (c.source as { path: string }).path);
                  const info = ed.shotInfo(c.id);
                  const selected = c.id === ed.selected;
                  const label = info?.label ?? (c.source.kind === 'solid' ? 'Text card' : c.source.path);
                  const sound = c.source.kind === 'clip' ? ed.sounds.current.get(c.source.path) : undefined;
                  return (
                    <div key={c.id} data-clip={c.id} data-track="v1" title={`${label} · ${c.duration.toFixed(1)}s`} className={cx('h-full shrink-0 px-px', insertAt?.id === c.id && 'opacity-40')} style={{ width: pct(c.duration) }}>
                      <div
                        className={cx(
                          'relative flex h-full cursor-grab items-stretch overflow-hidden rounded-md text-white active:cursor-grabbing',
                          KIND_BG[c.source.kind],
                          // An inset ring, not a border: a border would change
                          // the clip's width and shift every clip after it.
                          selected ? 'ring-2 ring-inset ring-ink' : 'ring-1 ring-inset ring-black/25',
                        )}
                      >
                        {offline && (
                          <span className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-[repeating-linear-gradient(135deg,rgb(var(--bad)/0.55)_0_6px,rgb(var(--bad)/0.35)_6px_12px)] text-2xs font-semibold" title="Media offline: import the file again to relink">
                            Offline
                          </span>
                        )}
                        <ClipThumb clip={c} ed={ed} className="hidden h-full w-7 rounded-none opacity-90 sm:flex" />
                        {pxOf(c.duration) >= 56 && (
                          <span className="flex min-w-0 flex-col justify-center px-2">
                            <span className="truncate text-xs font-semibold">{label}</span>
                            <span className="tabular truncate text-2xs text-white/75">
                              {c.duration.toFixed(1)}s{c.volume !== undefined && c.volume !== 1 ? ` · ${Math.round(c.volume * 100)}%` : ''}
                            </span>
                          </span>
                        )}
                        {sound && !ed.muted.v1 && (
                          <span className="pointer-events-none absolute inset-x-0 bottom-0 h-3 text-white/45">
                            <Waveform peaks={sound.peaks} from={c.sourceIn} to={c.sourceIn + c.duration} />
                          </span>
                        )}
                        {edges}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Captions */}
              <div className="relative h-9 border-t border-line" aria-label={`${ed.cues.length} captions`}>
                {ed.cues.map((cue, i) => {
                  const live = nowMs >= cue.startMs && nowMs < cue.endMs;
                  return (
                    <span
                      key={i}
                      title={cue.lines.join(' ')}
                      className={cx(
                        'absolute inset-y-1.5 overflow-hidden rounded px-1.5 text-2xs leading-6 text-cue-ink',
                        live ? 'bg-cue ring-1 ring-inset ring-ink' : 'bg-cue/70',
                      )}
                      style={{ left: pct(cue.startMs / 1000), width: `calc(${pct((cue.endMs - cue.startMs) / 1000)} - 2px)` }}
                    >
                      {pxOf((cue.endMs - cue.startMs) / 1000) >= 48 && <span className="block truncate">{cue.lines.join(' ')}</span>}
                    </span>
                  );
                })}
              </div>

              {/* A1 music */}
              <div data-drop={MUSIC} className="relative h-12 border-t border-line data-[drop-active]:bg-select/10 data-[drop-active]:ring-2 data-[drop-active]:ring-inset data-[drop-active]:ring-select">
                {ed.musicClips.map((c) => {
                  const sound = c.source.kind === 'clip' ? ed.sounds.current.get(c.source.path) : undefined;
                  return freeClip(
                    c,
                    MUSIC,
                    <span className={cx('absolute inset-0 flex flex-col', ed.muted.a1 && 'opacity-40')}>
                      <span className="truncate px-2 pt-1 text-2xs font-semibold text-cue-ink">
                        {c.source.kind === 'solid' ? '' : c.source.path} · {Math.round((c.volume ?? 1) * 100)}%
                      </span>
                      {sound && (
                        <span className="min-h-0 flex-1 px-1 pb-1 text-cue-ink/70">
                          <Waveform peaks={sound.peaks} from={c.sourceIn} to={c.sourceIn + c.duration} />
                        </span>
                      )}
                    </span>,
                    'bg-cue/80',
                  );
                })}
              </div>

              {/* Playhead */}
              <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 -ml-px w-0.5 bg-accent" style={{ left: pct(ed.playhead) }}>
                <span className="absolute -left-[5px] top-0 h-3.5 w-3 bg-accent" style={{ clipPath: 'polygon(0 0, 100% 0, 100% 60%, 50% 100%, 0 60%)' }} />
              </div>
            </div>

            {ed.problems.length > 0 && <p className="pb-2 text-xs text-bad">{ed.problems.map((p) => `${p.clip}: ${p.what}`).join(' · ')}</p>}
          </div>
        </div>
      </div>
    </section>
  );
}
