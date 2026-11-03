import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { detectBeats, planPolish, type Suggestion } from '../../../studio/src/lib/polish.js';
import { Button, cx, useToast } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { LOOKS } from './effects';
import type { Editor } from './useEditor';

/**
 * The editor's pass: a rough cut read the way an editor reads it, with
 * every change proposed, explained, and left to the creator to take.
 *
 * Two halves. What can be measured is measured here, in the browser: the
 * beats in the music, where each cut falls against them, which stills sit
 * too long, whether the clips carry speech. What needs judgement -- one look
 * for what the reel is about, the line that carries the turn -- is asked of
 * the model, and the pass still works without it. Applied as one edit, so
 * one undo takes the whole pass back.
 */

interface Result {
  suggestions: Suggestion[];
  bpm: number | null;
  notes: string;
}

export function Polish({ ed, language }: { ed: Editor; language: string }) {
  const toast = useToast();
  const [result, setResult] = useState<Result | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const read = async () => {
    setBusy(true);
    try {
      // The beats, wherever music sits on the timeline.
      const beats: number[] = [];
      let bpm: number | null = null;
      for (const m of ed.musicClips) {
        if (m.source.kind !== 'clip') continue;
        const sound = ed.sounds.current.get(m.source.path);
        if (!sound) continue;
        const buf = sound.buffer;
        const rate = buf.sampleRate;
        const from = Math.floor(m.sourceIn * rate);
        const to = Math.min(buf.length, Math.floor((m.sourceIn + m.duration) * rate));
        if (to - from < rate) continue;
        const mono = new Float32Array(to - from);
        for (let ch = 0; ch < buf.numberOfChannels; ch += 1) {
          const data = buf.getChannelData(ch);
          for (let i = 0; i < mono.length; i += 1) mono[i]! += data[from + i]! / buf.numberOfChannels;
        }
        const found = detectBeats(mono, rate);
        bpm ??= found.bpm;
        for (const t of found.times) beats.push(m.start + t);
      }

      // Speech: main-track video whose own sound is heard.
      const voice = !ed.muted.v1 && ed.clips.some((c) => c.source.kind === 'clip' && ed.sounds.current.has(c.source.path));

      // The judgement half, if the server has a model.
      let look = null;
      let emphasis: { id: string; reason: string }[] = [];
      let notes: string;
      try {
        const n = await api.aiEditNotes(
          // An asset is a still graphic: for an editor's purposes, a picture.
          ed.clips.map((c) => ({ id: c.id, text: c.caption, kind: c.source.kind === 'asset' ? 'photo' : c.source.kind, seconds: c.duration })),
          language,
        );
        const preset = LOOKS.find((l) => l.id === n.look);
        if (preset && n.look !== 'natural') look = { label: preset.label, grade: preset.grade, reason: n.lookReason };
        emphasis = n.emphasis;
        notes = n.look === 'natural' ? `Notes: ${n.lookReason}` : 'Look and emphasis from the editor’s notes.';
      } catch (e) {
        notes =
          e instanceof ApiError && e.status === 503
            ? 'AI notes are not set up here, so no look or emphasis is suggested. The rest is measured from your cut.'
            : `AI notes were not available (${e instanceof Error ? e.message : 'unknown'}). The rest is measured from your cut.`;
      }

      const labelOf = (c: (typeof ed.clips)[number]) => ed.shotInfo(c.id)?.label ?? (c.caption.trim() ? `“${c.caption.trim().slice(0, 28)}”` : 'that shot');
      const suggestions = planPolish({ timeline: ed.timeline, beats, voice, look, emphasis, labelOf });
      setResult({ suggestions, bpm, notes });
      setChosen(new Set(suggestions.map((s) => s.key)));
    } finally {
      setBusy(false);
    }
  };

  const apply = () => {
    if (!result) return;
    const picked = result.suggestions.filter((s) => chosen.has(s.key));
    ed.actions.polish(picked.flatMap((s) => s.changes));
    toast(`${picked.length} ${picked.length === 1 ? 'edit' : 'edits'} applied. Ctrl+Z takes them all back.`);
    setResult(null);
  };

  if (ed.clips.length === 0) {
    return <p className="p-4 text-xs text-ink-3">Make the reel first: the pass reads a cut that exists.</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-3 border-b border-line p-4">
        <p className="text-xs leading-relaxed text-ink-2">
          Reads your cut the way an editor would: cuts against the music, movement on stills, one look, the music under the voice.
          Every change is listed with its reason; keep the ones you want.
        </p>
        {ed.musicClips.length === 0 && <p className="text-xs text-ink-3">Add music to the music track to cut on its beat.</p>}
        <Button size="sm" variant={result ? 'secondary' : 'primary'} full busy={busy} onClick={read}>
          <Sparkles aria-hidden="true" className="h-4 w-4" />
          {result ? 'Read the cut again' : 'Suggest edits'}
        </Button>
      </div>

      {result && (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <p className="tabular mb-3 text-2xs text-ink-3">
            {result.bpm ? `Music at ${result.bpm} BPM. ` : ''}
            {result.notes}
          </p>
          {result.suggestions.length === 0 ? (
            <p className="text-sm text-ink-2">Nothing to change: this cut already does what the pass checks for.</p>
          ) : (
            <fieldset>
              <legend className="sr-only">Suggested edits</legend>
              <ul className="space-y-2">
                {result.suggestions.map((s) => {
                  const on = chosen.has(s.key);
                  return (
                    <li key={s.key}>
                      <label className={cx('flex cursor-pointer gap-3 rounded-md border p-3 transition-colors', on ? 'border-line-strong bg-panel-2' : 'border-line')}>
                        <input
                          type="checkbox"
                          className="mt-0.5 h-3.5 w-3.5 shrink-0"
                          checked={on}
                          onChange={() =>
                            setChosen((prev) => {
                              const next = new Set(prev);
                              if (next.has(s.key)) next.delete(s.key);
                              else next.add(s.key);
                              return next;
                            })
                          }
                        />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-ink">{s.title}</span>
                          <span className="mt-0.5 block text-xs leading-relaxed text-ink-3">{s.reason}</span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              <Button className="mt-4" variant="primary" size="sm" full disabled={chosen.size === 0} onClick={apply}>
                Apply {chosen.size} {chosen.size === 1 ? 'edit' : 'edits'}
              </Button>
            </fieldset>
          )}
        </div>
      )}
    </div>
  );
}
