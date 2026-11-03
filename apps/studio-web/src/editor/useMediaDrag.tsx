import { Film, Image as ImageIcon, Music } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MUSIC, OVERLAY, type Editor, type MediaItem } from './useEditor';

/**
 * Dragging media from the bin onto a track, by mouse or by finger.
 *
 * Pointer events, not HTML drag-and-drop: the browser's own drag does not
 * exist on a phone. A mouse picks a tile up once it has moved a few pixels.
 * A finger has to rest on it for a moment first, so an ordinary swipe still
 * scrolls the bin -- the same distinction every touch editor makes.
 *
 * The tracks mark themselves with `data-drop` and the strip carries the
 * reel's length, so the drop lands at the time under the finger: on the main
 * track at the nearest cut, on the overlay and music tracks exactly there.
 * Sound always goes to the music track, wherever it is let go.
 */

const HOLD_MS = 260;

interface Live {
  item: MediaItem;
  x: number;
  y: number;
}

export function useMediaDrag(ed: Editor) {
  const edRef = useRef(ed);
  edRef.current = ed;
  const [live, setLive] = useState<Live | null>(null);
  const cleanup = useRef<() => void>(() => undefined);
  useEffect(() => () => cleanup.current(), []);

  const begin = (item: MediaItem, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY };
    const touch = e.pointerType === 'touch';
    let dragging = false;
    let zone: HTMLElement | null = null;
    let timer = 0;

    const mark = (next: HTMLElement | null) => {
      if (zone === next) return;
      zone?.removeAttribute('data-drop-active');
      next?.setAttribute('data-drop-active', '');
      zone = next;
    };
    const pickUp = (x: number, y: number) => {
      dragging = true;
      document.body.style.userSelect = 'none';
      if (touch) navigator.vibrate?.(8);
      setLive({ item, x, y });
    };
    const move = (ev: PointerEvent) => {
      if (!dragging) {
        const far = Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > (touch ? 10 : 6);
        // A finger that moves before the hold is scrolling, not dragging.
        if (far && touch) return finish();
        if (far) pickUp(ev.clientX, ev.clientY);
        return;
      }
      setLive({ item, x: ev.clientX, y: ev.clientY });
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      mark((under?.closest('[data-drop]') as HTMLElement | null) ?? null);
      // Near the top or bottom of the screen, the page follows the finger.
      if (ev.clientY > window.innerHeight - 56) window.scrollBy(0, 14);
      else if (ev.clientY < 56) window.scrollBy(0, -14);
    };
    const holdStill = (ev: TouchEvent) => {
      if (dragging && ev.cancelable) ev.preventDefault();
    };
    const up = (ev: PointerEvent) => {
      if (dragging && zone && ev.type === 'pointerup') drop(zone, ev.clientX);
      finish();
    };
    const finish = () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('touchmove', holdStill);
      mark(null);
      document.body.style.userSelect = '';
      setLive(null);
      cleanup.current = () => undefined;
    };
    const drop = (target: HTMLElement, clientX: number) => {
      const strip = target.closest('[data-strip]') as HTMLElement | null;
      const box = strip?.getBoundingClientRect();
      const total = Number(strip?.dataset.total ?? 0);
      const time = box && box.width > 0 ? Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * total : 0;
      const track = target.dataset.drop;
      const act = edRef.current.actions;
      if (item.kind === 'audio') act.placeMusic(item.name, time);
      else if (track === OVERLAY) act.placeOverlay(item.name, time);
      else if (track === 'v1') act.place(item.name, total === 0 ? undefined : time);
      // A picture let go on the music track has nowhere to go: nothing happens.
      else if (track === MUSIC) return;
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('touchmove', holdStill, { passive: false });
    if (touch) timer = window.setTimeout(() => pickUp(start.x, start.y), HOLD_MS);
    cleanup.current = finish;
  };

  const ghost: ReactNode = live
    ? createPortal(
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-[80] flex h-14 w-24 -translate-x-1/2 -translate-y-[120%] items-center gap-1.5 rounded-md border border-line-strong bg-panel-2 px-2 text-2xs text-ink shadow-float"
          style={{ left: live.x, top: live.y }}
        >
          {live.item.kind === 'audio' ? (
            <Music className="h-3.5 w-3.5 shrink-0 text-cue" />
          ) : live.item.kind === 'photo' ? (
            <ImageIcon className="h-3.5 w-3.5 shrink-0 text-kind-photo" />
          ) : (
            <Film className="h-3.5 w-3.5 shrink-0 text-kind-clip" />
          )}
          <span className="min-w-0 truncate">{live.item.name}</span>
        </div>,
        document.body,
      )
    : null;

  return { begin, ghost, dragging: live !== null };
}
