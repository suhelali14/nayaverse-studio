import { Check } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './ui';

/**
 * Right-click menus, as desktop editors have them.
 *
 * One menu for the whole app, opened by whatever was right-clicked with the
 * entries that apply to it. Each entry names its action and shows its
 * keyboard shortcut, so the menu is also how people learn the shortcuts.
 *
 * Reachable without a mouse: the context-menu key or Shift+F10 opens it on
 * the focused thing (the browser fires `contextmenu` for both), arrows and
 * Home/End move, Enter or Space chooses, Escape closes and puts focus back
 * where it was. On a touchscreen a long press opens it (`useLongPress`).
 */

export type MenuEntry =
  | {
      kind?: 'item';
      label: string;
      shortcut?: string;
      onSelect: () => void;
      disabled?: boolean;
      danger?: boolean;
      /** A toggle: drawn with a tick, announced as a checkbox. */
      checked?: boolean;
    }
  | { kind: 'separator' }
  /** A row of choices on one line: speed, look, volume. */
  | { kind: 'row'; label: string; options: { label: string; active?: boolean; onSelect: () => void }[] };

interface Open {
  x: number;
  y: number;
  entries: MenuEntry[];
  label: string;
  returnTo: HTMLElement | null;
}

type OpenMenu = (at: { x: number; y: number } | React.MouseEvent | MouseEvent, entries: MenuEntry[], label?: string) => void;

const Ctx = createContext<OpenMenu>(() => undefined);
export const useContextMenu = () => useContext(Ctx);

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<Open | null>(null);

  const open = useCallback<OpenMenu>((at, entries, label = 'Actions') => {
    let x: number;
    let y: number;
    if ('preventDefault' in at) {
      at.preventDefault();
      x = at.clientX;
      y = at.clientY;
      // From the keyboard the event carries no pointer position: open at the
      // element it was fired on instead of the window's corner.
      if (x === 0 && y === 0 && at.target instanceof Element) {
        const r = at.target.getBoundingClientRect();
        x = r.left + Math.min(24, r.width / 2);
        y = r.top + Math.min(24, r.height / 2);
      }
    } else {
      x = at.x;
      y = at.y;
    }
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMenu({ x, y, entries, label, returnTo: active });
  }, []);

  const close = useCallback((restore: boolean) => {
    setMenu((m) => {
      if (restore) m?.returnTo?.focus({ preventScroll: true });
      return null;
    });
  }, []);

  return (
    <Ctx.Provider value={open}>
      {children}
      {menu && createPortal(<Menu menu={menu} onClose={close} />, document.body)}
    </Ctx.Provider>
  );
}

function Menu({ menu, onClose }: { menu: Open; onClose: (restore: boolean) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });

  // Kept inside the window: flipped left or up when it would run off.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    const x = menu.x + r.width + pad > window.innerWidth ? Math.max(pad, menu.x - r.width) : menu.x;
    const y = menu.y + r.height + pad > window.innerHeight ? Math.max(pad, window.innerHeight - r.height - pad) : menu.y;
    setPos({ x, y });
    items()[0]?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu]);

  const items = () => Array.from(box.current?.querySelectorAll<HTMLElement>('[data-menuitem]:not([disabled])') ?? []);

  useEffect(() => {
    const away = (e: Event) => {
      if (box.current && e.target instanceof Node && box.current.contains(e.target)) return;
      onClose(false);
    };
    const gone = () => onClose(false);
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('blur', gone);
    window.addEventListener('resize', gone);
    window.addEventListener('scroll', gone, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('blur', gone);
      window.removeEventListener('resize', gone);
      window.removeEventListener('scroll', gone, true);
    };
  }, [onClose]);

  const onKey = (e: React.KeyboardEvent) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => {
      e.preventDefault();
      list[(n + list.length) % list.length]?.focus();
    };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
    else if (e.key === 'ArrowRight' && (list[i]?.dataset.row ?? '') !== '') go(i + 1);
    else if (e.key === 'ArrowLeft' && (list[i]?.dataset.row ?? '') !== '') go(i - 1);
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      onClose(true);
    }
  };

  const choose = (fn: () => void) => {
    onClose(true);
    fn();
  };

  return (
    <div
      ref={box}
      role="menu"
      aria-label={menu.label}
      tabIndex={-1}
      onKeyDown={onKey}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-[70] min-w-[15rem] max-w-[20rem] rounded-lg border border-line-strong bg-panel-2 p-1 text-sm text-ink shadow-float"
    >
      {menu.entries.map((entry, i) => {
        if (entry.kind === 'separator') return <div key={i} role="separator" className="my-1 h-px bg-line" />;
        if (entry.kind === 'row') {
          return (
            <div key={i} role="group" aria-label={entry.label} className="flex items-center gap-1 px-2 py-1">
              <span className="mr-auto pr-3 text-xs text-ink-3">{entry.label}</span>
              {entry.options.map((o) => (
                <button
                  key={o.label}
                  type="button"
                  role="menuitemradio"
                  aria-checked={o.active === true}
                  data-menuitem=""
                  data-row={entry.label}
                  onClick={() => choose(o.onSelect)}
                  className={cx(
                    'h-7 rounded px-2 text-xs font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-select',
                    o.active ? 'bg-panel-3 text-ink' : 'text-ink-2 hover:bg-panel-3 hover:text-ink focus:bg-panel-3',
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
          );
        }
        const toggle = entry.checked !== undefined;
        return (
          <button
            key={i}
            type="button"
            role={toggle ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={toggle ? entry.checked : undefined}
            data-menuitem=""
            disabled={entry.disabled}
            onClick={() => choose(entry.onSelect)}
            className={cx(
              'flex h-8 w-full items-center gap-2 rounded px-2 text-left outline-none transition-colors',
              'hover:bg-panel-3 focus:bg-panel-3 disabled:pointer-events-none disabled:opacity-40',
              entry.danger ? 'text-bad' : 'text-ink',
            )}
          >
            <span className="flex w-4 shrink-0 justify-center" aria-hidden="true">
              {entry.checked && <Check className="h-3.5 w-3.5" strokeWidth={2.5} />}
            </span>
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {entry.shortcut && (
              <kbd className="tabular ml-4 shrink-0 font-sans text-xs text-ink-3" aria-label={`Shortcut ${entry.shortcut}`}>
                {entry.shortcut}
              </kbd>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A long press, for touchscreens, where there is no right button.
 *
 * Half a second without moving more than a few pixels counts. Returns the
 * pointer handlers to spread on the element, and `fired()` so a click that
 * ends a long press can be ignored.
 */
export function useLongPress(onPress: (at: { x: number; y: number }, target: EventTarget | null) => void, ms = 500) {
  const timer = useRef(0);
  const start = useRef<{ x: number; y: number } | null>(null);
  const didFire = useRef(false);
  const cancel = () => {
    window.clearTimeout(timer.current);
    start.current = null;
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return {
    handlers: {
      onPointerDown: (e: React.PointerEvent) => {
        didFire.current = false;
        if (e.pointerType !== 'touch') return;
        start.current = { x: e.clientX, y: e.clientY };
        const target = e.target;
        timer.current = window.setTimeout(() => {
          if (!start.current) return;
          didFire.current = true;
          navigator.vibrate?.(10);
          onPress(start.current, target);
          start.current = null;
        }, ms);
      },
      onPointerMove: (e: React.PointerEvent) => {
        if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 8) cancel();
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
    },
    fired: () => didFire.current,
  };
}
