import { AlertOctagon, AlertTriangle, Clapperboard, Info } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { directReel, type DirectedReel, type LibraryItem } from '../../../studio/src/lib/director.js';
import {
  planFromScript,
  planRenderable,
  validatePlan,
  type PlanProblem,
  type ScenePlan,
} from '../../../studio/src/lib/scenes.js';
import { ApiError, api, type AiStatus, type PlanMode, type PlanResult } from '../lib/api';
import type { DubTarget } from '../lib/catalogue';
import { Button, Input, Segmented, Select, Textarea, cx } from '../components/ui';

/**
 * The Script panel: a script or a topic in, a cut reel on the timeline out.
 *
 * ── Three modes, and which ones need the network ───────────────────────
 *
 * Cut runs here, in the browser, with the same planner and validator the
 * server uses -- `scenes.ts` is one module imported by both. It needs no
 * key, no credit and no connection, which is why it is never disabled.
 * Write and Tighten need a model, so they go to `/api/ai/plan`, and they
 * are switched off up front when the server says it has none rather than
 * offered as buttons that fail.
 *
 * ── A plan with faults still lands on the timeline ─────────────────────
 *
 * The validator decides what may be *published*; it does not decide what
 * a creator may edit. A reel four seconds over budget is most quickly fixed
 * by deleting a shot, and that needs the shots on the timeline. So the cut
 * is placed and its faults are listed beside it, ranked.
 */

const MODES: readonly { id: PlanMode; label: string; needsModel: boolean; hint: string }[] = [
  { id: 'write', label: 'Write', needsModel: true, hint: 'Describe the reel and get a script split into scenes.' },
  { id: 'tighten', label: 'Tighten', needsModel: true, hint: 'Your script, edited down, with your facts kept.' },
  { id: 'cut', label: 'As written', needsModel: false, hint: 'Your script exactly as written, split into scenes.' },
];

type Severity = 'fault' | 'warning' | 'note';

interface Finding {
  readonly severity: Severity;
  readonly where: string;
  readonly detail: string;
}

/** Where a validator problem points, in the creator's terms. */
function locate(problem: PlanProblem, plan: ScenePlan): string {
  if (problem.sceneIndex === null) return 'Whole reel';
  if (problem.sceneIndex === -1) return 'Hook';
  if (problem.sceneIndex >= plan.scenes.length) return 'Call to action';
  return `Scene ${problem.sceneIndex + 1}`;
}

function findingsFor(result: PlanResult, reel: DirectedReel | null): Finding[] {
  const out: Finding[] = result.problems.map((p) => ({
    severity: p.blocking ? 'fault' : 'warning',
    where: locate(p, result.plan),
    detail: p.detail,
  }));
  if (reel && reel.fills > 0) {
    out.push({
      severity: 'note',
      where: 'Media',
      detail: `${reel.fills} scene${reel.fills === 1 ? '' : 's'} got footage that matched nothing. Check they fit.`,
    });
  }
  if (reel && reel.cards > 0) {
    out.push({
      severity: 'note',
      where: 'Media',
      detail: `${reel.cards} scene${reel.cards === 1 ? ' is a text card' : 's are text cards'}. Import clips whose file names say what they show.`,
    });
  }
  const rank: Record<Severity, number> = { fault: 0, warning: 1, note: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

const MARK = {
  fault: { icon: AlertOctagon, className: 'text-bad', word: 'Must fix' },
  warning: { icon: AlertTriangle, className: 'text-warn', word: 'Check' },
  note: { icon: Info, className: 'text-ink-3', word: 'Note' },
} as const;

/** Severity is carried by the icon and its word, never by colour alone. */
function Findings({ items }: { items: readonly Finding[] }) {
  if (items.length === 0) {
    return <p className="px-4 py-3 text-xs text-good">Within every limit.</p>;
  }
  return (
    <ul className="divide-y divide-line" aria-label="Review">
      {items.map((f, i) => {
        const m = MARK[f.severity];
        return (
          <li key={i} className="flex gap-2.5 px-4 py-2.5">
            <m.icon aria-hidden="true" className={cx('mt-0.5 h-3.5 w-3.5 shrink-0', m.className)} />
            <p className="text-xs leading-relaxed text-ink-2">
              <span className="font-semibold text-ink">
                {f.where}
                <span className="sr-only"> ({m.word})</span>
              </span>{' '}
              {f.detail}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

export function Director({
  status,
  library,
  languages,
  defaultLanguage,
  hasCut,
  onDirect,
  initialScript,
}: {
  /** Null while loading, or when the API could not be reached. */
  status: AiStatus | null;
  library: readonly LibraryItem[];
  languages: readonly DubTarget[];
  defaultLanguage: string;
  /** Whether a run would replace a cut that is already on the timeline. */
  hasCut: boolean;
  onDirect: (reel: DirectedReel, result: PlanResult) => void;
  /** A script handed over from Ideas, opened as written. */
  initialScript?: string;
}) {
  const canWrite = status?.write === true;
  const [mode, setMode] = useState<PlanMode>(initialScript ? 'cut' : canWrite ? 'write' : 'cut');
  // The status arrives after the first render. When it says a model is
  // available, start in Write -- unless the creator already chose a mode,
  // or arrived with a script to use as written.
  const chose = useRef(Boolean(initialScript));
  useEffect(() => {
    if (canWrite && !chose.current) setMode('write');
  }, [canWrite]);
  const [text, setText] = useState(initialScript ?? '');
  const [language, setLanguage] = useState(defaultLanguage);
  const [audience, setAudience] = useState('');
  const [fill, setFill] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<PlanResult | null>(null);
  const [reel, setReel] = useState<DirectedReel | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A mode needing a model is never left selected on a server without one.
  const effective: PlanMode = MODES.find((m) => m.id === mode)?.needsModel && !canWrite ? 'cut' : mode;
  const empty = text.trim().length < 3;

  const run = async () => {
    setError(null);
    if (hasCut && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    try {
      let next: PlanResult;
      if (effective === 'cut') {
        const plan = planFromScript(text);
        const problems = validatePlan(plan);
        next = { plan, problems, renderable: planRenderable(problems), source: 'rules', model: null, attempts: 0 };
      } else {
        next = await api.plan({
          mode: effective,
          text,
          language,
          ...(audience.trim() ? { audience: audience.trim() } : {}),
          library: library.map((item) => item.name),
        });
      }
      const directed = directReel(next.plan, library, { fill });
      setResult(next);
      setReel(directed);
      onDirect(directed, next);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    }
  };

  const scenes = result ? result.plan.scenes.length + 1 + (result.plan.cta ? 1 : 0) : 0;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="space-y-3 p-4">
        <Segmented
          label="How to use your text"
          value={effective}
          onChange={(id) => {
            chose.current = true;
            setMode(id);
            setConfirming(false);
          }}
          options={MODES.map((m) => ({
            id: m.id,
            label: m.label,
            disabled: m.needsModel && !canWrite,
            title: m.needsModel && !canWrite ? 'AI writing is not available on this workspace' : m.hint,
          }))}
        />

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-ink-2">
            {effective === 'write' ? 'Topic' : 'Script'}
          </span>
          <Textarea
            rows={effective === 'write' ? 4 : 9}
            value={text}
            maxLength={6000}
            onChange={(e) => {
              setText(e.target.value);
              setConfirming(false);
            }}
            placeholder={
              effective === 'write'
                ? 'Why a small clinic needs its own website'
                : 'Paste or type your script. Each sentence becomes part of a scene.'
            }
          />
        </label>

        {effective !== 'cut' && (
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-ink-2">Language</span>
              <Select compact value={language} onChange={(e) => setLanguage(e.target.value)}>
                {languages.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.native === l.english ? l.english : `${l.native} · ${l.english}`}
                  </option>
                ))}
              </Select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-ink-2">Audience</span>
              <Input
                className="h-8"
                value={audience}
                maxLength={200}
                onChange={(e) => setAudience(e.target.value)}
                placeholder="clinic owners"
              />
            </label>
          </div>
        )}

        <label className="flex items-center gap-2 text-xs text-ink-2">
          <input type="checkbox" checked={fill} onChange={(e) => setFill(e.target.checked)} className="h-3.5 w-3.5" />
          Fill unmatched scenes with footage
        </label>

        {confirming ? (
          <div className="rounded-md border border-line-strong bg-panel-2 p-3" role="status">
            <p className="text-xs text-ink">Replace the scenes on the timeline?</p>
            <div className="mt-2 flex gap-2">
              <Button variant="primary" size="xs" onClick={run}>
                Replace
              </Button>
              <Button variant="ghost" size="xs" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="primary" size="sm" full disabled={empty} onClick={run}>
            <Clapperboard aria-hidden="true" className="h-4 w-4" />
            {effective === 'write' ? 'Write the reel' : 'Make the reel'}
          </Button>
        )}

        {error && (
          <p role="alert" className="rounded-md bg-bad-soft px-3 py-2 text-xs text-bad">
            {error}
          </p>
        )}
      </div>

      {result && (
        <div className="border-t border-line">
          <div className="flex h-9 items-center justify-between px-4 text-xs">
            <span className="font-semibold text-ink">Review</span>
            <span className="tabular text-ink-3">
              {scenes} scenes · {result.plan.totalSeconds.toFixed(0)}s
              {result.source === 'model' && result.model ? ` · ${result.model}` : ''}
            </span>
          </div>
          <Findings items={findingsFor(result, reel)} />
        </div>
      )}
    </div>
  );
}
