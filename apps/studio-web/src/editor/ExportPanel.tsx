import { Download, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, IconButton, Spinner, cx } from '../components/ui';
import { CODEC_NAME, presetSupport, type ExportPreset, type PresetSupport } from './export';

/**
 * Export settings, dropped from the top bar: quality preset, sound, go.
 *
 * Presets are checked against this machine's encoders when the panel
 * opens, so a 4K option the browser cannot encode is shown disabled with
 * the reason, rather than failing a minute into an export.
 */
export function ExportPanel({
  open,
  onClose,
  hasSound,
  exporting,
  progress,
  onExport,
  onCancel,
}: {
  open: boolean;
  onClose: () => void;
  /** Whether anything on the timeline has audio to include. */
  hasSound: boolean;
  exporting: boolean;
  progress: number;
  onExport: (preset: ExportPreset, codec: NonNullable<PresetSupport['codec']>, withSound: boolean) => void;
  onCancel: () => void;
}) {
  const [support, setSupport] = useState<PresetSupport[] | null>(null);
  const [choice, setChoice] = useState<ExportPreset['id']>('high');
  const [sound, setSound] = useState(true);
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open && support === null) void presetSupport().then(setSupport);
  }, [open, support]);

  useEffect(() => {
    if (!open || exporting) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open, exporting, onClose]);

  if (!open) return null;
  const chosen = support?.find((s) => s.preset.id === choice);

  return (
    <div
      ref={box}
      role="dialog"
      aria-label="Export"
      className="absolute right-0 top-full z-50 mt-2 w-[min(22rem,calc(100vw-1rem))] rounded-lg border border-line-strong bg-panel-2 p-4 shadow-float"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Export</h2>
        {!exporting && (
          <IconButton small label="Close" onClick={onClose}>
            <X aria-hidden="true" className="h-4 w-4" />
          </IconButton>
        )}
      </div>

      {exporting ? (
        <div role="status" aria-live="polite">
          <div className="flex items-center justify-between text-xs text-ink-2">
            <span className="flex items-center gap-2">
              <Spinner className="h-3.5 w-3.5" />
              Encoding {chosen?.preset.label.toLowerCase() ?? ''}
            </span>
            <span className="tabular">{Math.round(progress * 100)}%</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-panel-3">
            <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${progress * 100}%` }} />
          </div>
          <Button size="sm" variant="ghost" className="mt-3" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      ) : (
        <>
          <fieldset>
            <legend className="sr-only">Quality</legend>
            <div className="space-y-1.5">
              {(support ?? []).map(({ preset, codec }) => (
                <label
                  key={preset.id}
                  className={cx(
                    'flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 transition-colors',
                    choice === preset.id ? 'border-ink-3 bg-panel-3' : 'border-line hover:bg-panel-3/60',
                    codec === null && 'cursor-not-allowed opacity-50',
                  )}
                >
                  <input
                    type="radio"
                    name="export-preset"
                    className="mt-1 h-3.5 w-3.5"
                    checked={choice === preset.id}
                    disabled={codec === null}
                    onChange={() => setChoice(preset.id)}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-ink">{preset.label}</span>
                    <span className="block text-xs text-ink-3">{preset.detail}</span>
                    <span className="block text-2xs text-ink-3">
                      {codec ? CODEC_NAME[codec] : 'This browser cannot encode this size'}
                    </span>
                  </span>
                </label>
              ))}
              {support === null && <p className="py-6 text-center text-xs text-ink-3">Checking this computer's encoders…</p>}
            </div>
          </fieldset>

          <label className={cx('mt-3 flex items-center gap-2 text-xs', hasSound ? 'text-ink-2' : 'text-ink-3')}>
            <input type="checkbox" className="h-3.5 w-3.5" checked={hasSound && sound} disabled={!hasSound} onChange={(e) => setSound(e.target.checked)} />
            {hasSound ? 'Include sound' : 'No sound on the timeline'}
          </label>

          <Button
            variant="primary"
            size="sm"
            full
            className="mt-4"
            disabled={!chosen?.codec}
            onClick={() => {
              if (chosen?.codec) onExport(chosen.preset, chosen.codec, hasSound && sound);
            }}
          >
            <Download aria-hidden="true" className="h-4 w-4" />
            Export MP4
          </Button>
        </>
      )}
    </div>
  );
}
