import { ArrowDown, ArrowUp, Scissors, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { FRAME_FPS } from '../../../studio/src/lib/compose.js';
import { Button, Segmented, Textarea, cx } from '../components/ui';
import { LOOKS, NEUTRAL } from './effects';
import type { Grade } from '../../../studio/src/lib/timeline.js';
import { formatClock } from './time';
import type { Editor } from './useEditor';

/**
 * The right-hand panel. It shows what is selected -- a main-track clip, an
 * overlay or a music clip -- and with nothing selected it shows the reel
 * itself, so the panel is never empty and never stale.
 */

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-xs">
      <dt className="text-ink-3">{label}</dt>
      <dd className="tabular min-w-0 truncate text-right text-ink">{children}</dd>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-3">
      <h3 className="mb-2 text-xs font-semibold text-ink">{title}</h3>
      {children}
    </section>
  );
}

const KIND_NAME = { clip: 'Video', photo: 'Photo', asset: 'Image', solid: 'Text card' } as const;

const SLIDERS: readonly { key: keyof Grade; label: string; min: number; max: number; step: number; show: (v: number) => string }[] = [
  { key: 'exposure', label: 'Exposure', min: 0.5, max: 1.5, step: 0.01, show: (v) => `${v >= 1 ? '+' : ''}${Math.round((v - 1) * 100)}` },
  { key: 'contrast', label: 'Contrast', min: 0.5, max: 1.6, step: 0.01, show: (v) => `${v >= 1 ? '+' : ''}${Math.round((v - 1) * 100)}` },
  { key: 'saturation', label: 'Saturation', min: 0, max: 2, step: 0.01, show: (v) => `${v >= 1 ? '+' : ''}${Math.round((v - 1) * 100)}` },
  { key: 'warmth', label: 'Warmth', min: -1, max: 1, step: 0.01, show: (v) => `${v >= 0 ? '+' : ''}${Math.round(v * 100)}` },
];

const sameGrade = (a: Grade, b: Grade) =>
  a.exposure === b.exposure && a.contrast === b.contrast && a.saturation === b.saturation && a.warmth === b.warmth;

export function Inspector({ ed, title, language }: { ed: Editor; title: string; language: string }) {
  const main = ed.clips.find((c) => c.id === ed.selected);
  const overlay = ed.overlayClips.find((c) => c.id === ed.selected);
  const music = ed.musicClips.find((c) => c.id === ed.selected);
  const clip = main ?? overlay ?? music;

  if (!clip) {
    return (
      <div>
        <div className="panel-head">Reel</div>
        <Group title="Details">
          <dl>
            <Row label="Title">{title}</Row>
            <Row label="Length">{ed.total.toFixed(1)}s</Row>
            <Row label="Format">9:16 · 1080×1920</Row>
            <Row label="Frame rate">{FRAME_FPS} fps</Row>
            <Row label="Language">{language}</Row>
          </dl>
        </Group>
        <Group title="Contents">
          <dl>
            <Row label="Scenes">{ed.clips.length}</Row>
            <Row label="Overlays">{ed.overlayClips.length}</Row>
            <Row label="Music">{ed.musicClips.length}</Row>
            <Row label="Captions">{ed.cues.length}</Row>
            <Row label="Markers">{ed.markers.length}</Row>
          </dl>
        </Group>
        <p className="px-4 py-3 text-xs text-ink-3">Select a clip to edit it.</p>
      </div>
    );
  }

  const info = main ? ed.shotInfo(clip.id) : undefined;
  const index = main ? ed.clips.findIndex((c) => c.id === clip.id) : -1;
  const hasSound = clip.source.kind === 'clip' && ed.sounds.current.has(clip.source.path) && !overlay;
  const heading = music ? 'Music' : overlay ? 'Overlay' : (info?.label ?? KIND_NAME[clip.source.kind]);
  const volume = clip.volume ?? 1;

  return (
    <div>
      <div className="panel-head">
        <span className="truncate">{heading}</span>
        {main && (
          <span className="text-xs font-normal text-ink-3">
            {index + 1} of {ed.clips.length}
          </span>
        )}
      </div>

      {main && (
        <Group title="Caption">
          <Textarea
            rows={3}
            aria-label="Caption"
            value={clip.caption}
            placeholder="Text shown on this clip"
            onChange={(e) => ed.actions.setCaption(clip.id, e.target.value)}
          />
          {ed.cues.length > 0 && <p className="mt-1.5 text-2xs leading-relaxed text-ink-3">Timed captions take over while words are spoken.</p>}
        </Group>
      )}

      {clip.source.kind !== 'solid' && !music && (
        <Group title="Look">
          <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Look presets">
            {LOOKS.map((l) => {
              const on = sameGrade(clip.grade ?? NEUTRAL, l.grade);
              return (
                <button
                  key={l.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => ed.actions.setLook(clip.id, l.grade)}
                  className={cx(
                    'h-7 rounded-md border px-2.5 text-xs transition-colors',
                    on ? 'border-ink-3 bg-panel-3 text-ink' : 'border-line text-ink-2 hover:text-ink',
                  )}
                >
                  {l.label}
                </button>
              );
            })}
          </div>
          {SLIDERS.map((s) => {
            const grade = clip.grade ?? NEUTRAL;
            const value = grade[s.key];
            return (
              <label key={s.key} className="flex items-center gap-3 py-1 text-xs text-ink-2">
                <span className="w-16 shrink-0">{s.label}</span>
                <input
                  type="range"
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  value={value}
                  aria-label={s.label}
                  onChange={(e) => ed.actions.setLook(clip.id, { ...grade, [s.key]: Number(e.target.value) })}
                  className="min-w-0 flex-1 accent-[rgb(var(--ink-2))]"
                />
                <span className="tabular w-9 text-right text-ink">{s.show(value)}</span>
              </label>
            );
          })}
        </Group>
      )}

      {!music && (
        <Group title="Motion">
          <div className="space-y-2.5">
            {clip.source.kind !== 'solid' && (
              <div>
                <p className="mb-1 text-2xs text-ink-3">Push</p>
                <Segmented
                  label="Push"
                  value={!clip.zoom ? 'none' : clip.zoom.to > clip.zoom.from ? 'in' : 'out'}
                  onChange={(v) =>
                    ed.actions.setMotion(clip.id, {
                      zoom: v === 'none' ? null : v === 'in' ? { from: 1, to: 1.15 } : { from: 1.15, to: 1 },
                    })
                  }
                  options={[
                    { id: 'none' as const, label: 'None' },
                    { id: 'in' as const, label: 'Push in' },
                    { id: 'out' as const, label: 'Pull out' },
                  ]}
                />
              </div>
            )}
            {clip.source.kind === 'clip' && (
              <div>
                <p className="mb-1 text-2xs text-ink-3">Speed</p>
                <Segmented
                  label="Speed"
                  value={String(clip.speed ?? 1) as '0.5' | '1' | '1.5' | '2'}
                  onChange={(v) => ed.actions.setSpeed(clip.id, Number(v))}
                  options={[
                    { id: '0.5' as const, label: '0.5×' },
                    { id: '1' as const, label: '1×' },
                    { id: '1.5' as const, label: '1.5×' },
                    { id: '2' as const, label: '2×' },
                  ]}
                />
              </div>
            )}
            {main && (
              <div className="flex gap-4 pt-1 text-xs text-ink-2">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5"
                    checked={(clip.fadeIn ?? 0) > 0}
                    onChange={(e) => ed.actions.setMotion(clip.id, { fadeIn: e.target.checked ? 0.5 : 0 })}
                  />
                  Fade in
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5"
                    checked={(clip.fadeOut ?? 0) > 0}
                    onChange={(e) => ed.actions.setMotion(clip.id, { fadeOut: e.target.checked ? 0.5 : 0 })}
                  />
                  Fade out
                </label>
              </div>
            )}
          </div>
        </Group>
      )}

      {hasSound && (
        <Group title="Sound">
          <label className="flex items-center gap-3 text-xs text-ink-2">
            <span className="w-14 shrink-0">Volume</span>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={volume}
              onChange={(e) => ed.actions.setVolume(clip.id, Number(e.target.value))}
              className="min-w-0 flex-1 accent-[rgb(var(--accent))]"
              aria-label="Volume"
            />
            <span className="tabular w-10 text-right text-ink">{Math.round(volume * 100)}%</span>
          </label>
          {music && <p className="mt-1.5 text-2xs text-ink-3">Music under a voice usually sits at 20–40%.</p>}
        </Group>
      )}

      <Group title="Timing">
        <dl>
          <Row label="Starts">{formatClock(clip.start)}</Row>
          <Row label="Duration">{clip.duration.toFixed(2)}s</Row>
          {clip.source.kind === 'clip' && <Row label="Source in">{formatClock(clip.sourceIn)}</Row>}
        </dl>
        <p className="mt-1 text-2xs text-ink-3">
          {main ? "Drag a clip's edges on the timeline to trim." : 'Drag the clip to move it; drag its edges to trim.'}
        </p>
      </Group>

      <Group title="Source">
        <dl>
          <Row label="Type">{music ? 'Sound' : KIND_NAME[clip.source.kind]}</Row>
          {clip.source.kind !== 'solid' && <Row label="File">{clip.source.path}</Row>}
          {info && info.match.kind === 'keyword' && <Row label="Matched on">{info.match.on.join(', ')}</Row>}
          {info && info.match.kind !== 'keyword' && <Row label="Looked for">{info.visual}</Row>}
        </dl>
      </Group>

      <div className="grid grid-cols-2 gap-2 p-4">
        {main && (
          <>
            <Button size="xs" disabled={index <= 0} onClick={() => ed.actions.move(-1)}>
              <ArrowUp aria-hidden="true" className="h-3.5 w-3.5" />
              Earlier
            </Button>
            <Button size="xs" disabled={index >= ed.clips.length - 1} onClick={() => ed.actions.move(1)}>
              <ArrowDown aria-hidden="true" className="h-3.5 w-3.5" />
              Later
            </Button>
            <Button size="xs" onClick={ed.actions.split}>
              <Scissors aria-hidden="true" className="h-3.5 w-3.5" />
              Split
            </Button>
          </>
        )}
        <Button size="xs" variant="danger" onClick={ed.actions.remove} className={main ? undefined : 'col-span-2'}>
          <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
          Delete
        </Button>
      </div>
    </div>
  );
}
