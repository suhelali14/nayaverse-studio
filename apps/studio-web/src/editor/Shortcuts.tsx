import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { IconButton } from '../components/ui';
import { MOD } from './menus';

/**
 * Every keyboard shortcut, on one sheet. Opened with ? or the keyboard
 * button in the top bar. The same keys are shown beside each entry in the
 * right-click menus, so this is the list and the menus are the reminders.
 */

const GROUPS: { title: string; keys: [string, string][] }[] = [
  {
    title: 'Play',
    keys: [
      ['Space', 'Play or pause'],
      ['J  K  L', 'Back, stop, forward; again for faster'],
      ['← →', 'One frame; with Shift, one second'],
      ['Home  End', 'Start or end of the reel'],
      ['M', 'Marker at the playhead'],
    ],
  },
  {
    title: 'Edit',
    keys: [
      ['S', 'Split at the playhead'],
      ['Q  W', 'Trim the start or end to the playhead'],
      ['Alt+← →', 'Move the clip earlier or later'],
      ['Delete', 'Delete; the main track closes up'],
      [`${MOD}D`, 'Duplicate'],
      [`${MOD}C  ${MOD}X  ${MOD}V`, 'Copy, cut, paste'],
      ['T', 'Add a text card'],
      [`${MOD}Z`, 'Undo'],
      [`${MOD}Shift+Z`, 'Redo'],
    ],
  },
  {
    title: 'View and output',
    keys: [
      ['=  −', 'Zoom the timeline in or out'],
      ['Shift+Z', 'Fit the whole reel'],
      ['Shift+F10', 'Actions for the selected clip'],
      [`${MOD}Shift+S`, 'Save the frame at the playhead'],
      [`${MOD}E`, 'Export'],
      ['Esc', 'Deselect'],
      ['?', 'This sheet'],
    ],
  },
];

export function Shortcuts({ open, onClose }: { open: boolean; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      back?.focus({ preventScroll: true });
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby="keys-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] w-full max-w-3xl overflow-y-auto rounded-xl border border-line-strong bg-panel p-5 shadow-float outline-none sm:p-6"
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 id="keys-title" className="text-base font-semibold text-ink">
            Keyboard shortcuts
          </h2>
          <IconButton small label="Close" onClick={onClose}>
            <X aria-hidden="true" className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="grid gap-6 sm:grid-cols-3">
          {GROUPS.map((g) => (
            <section key={g.title} aria-labelledby={`keys-${g.title}`}>
              <h3 id={`keys-${g.title}`} className="mb-2 text-xs font-semibold text-ink-2">
                {g.title}
              </h3>
              <dl className="space-y-1.5">
                {g.keys.map(([k, what]) => (
                  <div key={k} className="flex items-baseline justify-between gap-3 text-xs">
                    <dt className="text-ink-2">{what}</dt>
                    <dd className="m-0 shrink-0">
                      <kbd className="tabular rounded border border-line-strong bg-panel-2 px-1.5 py-0.5 font-sans text-2xs text-ink">{k}</kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
