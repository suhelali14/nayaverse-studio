import { ArrowLeft, Check, Clapperboard, PenLine, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AppShell } from '../components/chrome';
import { Badge, Button, Field, Input, Segmented, Select, Skeleton, Textarea, cx, useToast } from '../components/ui';
import { errorText } from '../components/project-card';
import { ApiError, api, type Goal, type SceneDraft, type ScriptDraft, type Tone, type WizardBrief } from '../lib/api';
import { useCatalogue } from '../lib/catalogue';
import { scriptKey } from '../lib/handoff';

/**
 * A new reel, written with AI and steered at every step.
 *
 *   1 Brief    topic, audience, language, tone, goal, length
 *   2 Hook     five openings to choose from, or your own
 *   3 Script   three versions on that hook; edit any scene, or have one
 *              scene rewritten on an instruction, without touching the rest
 *   4 Create   the reel opens in the editor with the script in place
 *
 * Each step is one small request, counted against the day's allowance,
 * which the page shows. The server checks every version for invented
 * numbers, promises and testimonials, and the findings are shown on the
 * version rather than hidden.
 */

type Step = 0 | 1 | 2 | 3;
const STEPS = ['Brief', 'Hook', 'Script', 'Create'] as const;
const QUICK = ['Shorter', 'More specific', 'Punchier', 'Simpler words'] as const;

export default function NewReel() {
  const navigate = useNavigate();
  const toast = useToast();
  const { catalogue } = useCatalogue();
  const [step, setStep] = useState<Step>(0);
  const [allowance, setAllowance] = useState<{ used: number; limit: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 503: the server has no writer. The page still works as a way to start
  // a blank reel, and says so instead of failing on every step.
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);

  const [brief, setBrief] = useState<WizardBrief>({ topic: '', language: 'en', tone: 'friendly', goal: 'educate', seconds: 30 });
  const [hooks, setHooks] = useState<{ text: string; angle: string }[]>([]);
  const [hook, setHook] = useState('');
  const [versions, setVersions] = useState<ScriptDraft[]>([]);
  const [pick, setPick] = useState(0);
  const [scenes, setScenes] = useState<SceneDraft[]>([]);
  const [cta, setCta] = useState('');
  const [rewriting, setRewriting] = useState<number | null>(null);
  const [custom, setCustom] = useState<Record<number, string>>({});
  const [title, setTitle] = useState('');

  const refreshAllowance = () => api.aiUsage().then(setAllowance, () => undefined);
  useEffect(() => {
    void refreshAllowance();
  }, []);

  const set = <K extends keyof WizardBrief>(key: K, value: WizardBrief[K]) => setBrief((b) => ({ ...b, [key]: value }));

  const run = async <T,>(work: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await work();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : errorText(e));
      if (e instanceof ApiError && e.status === 503) setOffline(true);
      return null;
    } finally {
      setBusy(false);
      void refreshAllowance();
    }
  };

  const writeHooks = async () => {
    const out = await run(() => api.aiHooks({ ...brief, ...(brief.audience?.trim() ? {} : { audience: undefined }) }));
    if (!out) return;
    // A hook the creator wrote themselves survives a fresh list; a pick
    // from the old list does not, since that list is gone.
    const own = hook.trim() !== '' && !hooks.some((h) => h.text === hook);
    setHooks(out.hooks);
    if (!own) setHook(out.hooks[0]?.text ?? '');
    setStep(1);
  };

  const writeScripts = async () => {
    const out = await run(() => api.aiScripts(brief, hook));
    if (!out) return;
    setVersions(out.versions);
    choose(out.versions, 0);
    setStep(2);
  };

  const choose = (list: ScriptDraft[], i: number) => {
    const v = list[i];
    if (!v) return;
    setPick(i);
    setScenes(v.scenes.map((s) => ({ ...s })));
    setCta(v.cta ?? '');
    setTitle(v.title);
  };

  const rewrite = async (index: number, instruction: string) => {
    setRewriting(index);
    const out = await run(() => api.aiRewrite(brief, scenes, index, instruction));
    setRewriting(null);
    if (!out) return;
    setScenes((list) => list.map((s, i) => (i === index ? out.scene : s)));
    setCustom((c) => ({ ...c, [index]: '' }));
  };

  const create = async () => {
    const script = [...scenes.map((s) => s.text.trim()), cta.trim()].filter(Boolean).join(' ');
    const project = await run(() => api.createProject({ title: (title || brief.topic).slice(0, 120), language: brief.language }));
    if (!project) return;
    try {
      sessionStorage.setItem(scriptKey(project.id), script);
    } catch {
      /* the editor opens empty; the script is still on this page */
    }
    toast('Reel created. Add footage, then press Make the reel.');
    navigate('/app/p/' + project.id);
  };

  const words = scenes.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0) + cta.split(/\s+/).filter(Boolean).length;
  const version = versions[pick];

  return (
    <AppShell
      title="New reel"
      actions={
        allowance && (
          <span className="tabular hidden text-xs text-ink-3 sm:inline" title="AI requests in the last 24 hours">
            AI {allowance.used} / {allowance.limit} today
          </span>
        )
      }
    >
      <div className="mx-auto max-w-3xl">
        <ol className="mb-8 grid grid-cols-4 gap-2" aria-label="Steps">
          {STEPS.map((name, i) => (
            <li key={name} aria-current={i === step ? 'step' : undefined}>
              <span className={cx('block h-1 rounded-full', i <= step ? 'bg-accent' : 'bg-panel-3')} />
              <span className={cx('mt-2 flex items-center gap-1.5 text-xs', i === step ? 'font-semibold text-ink' : i < step ? 'text-ink-2' : 'text-ink-3')}>
                {i < step && <Check aria-hidden="true" className="h-3.5 w-3.5 text-good" />}
                {i + 1}. {name}
              </span>
            </li>
          ))}
        </ol>

        {error && (
          <div role="alert" className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-md bg-bad-soft px-4 py-3 text-sm text-bad">
            <span>{error}</span>
            {offline && (
              <Link to="/app?new=1" className="font-medium underline">
                Start a blank reel
              </Link>
            )}
          </div>
        )}

        {step === 0 && (
          <section className="rounded-lg border border-line bg-panel p-5 sm:p-6" aria-labelledby="brief">
            <h2 id="brief" className="text-lg font-semibold text-ink">What is the reel about?</h2>
            <div className="mt-5 space-y-1">
              <Field label="Topic" htmlFor="topic" hint="One or two sentences. The more specific, the better the hooks.">
                <Textarea id="topic" rows={3} maxLength={600} value={brief.topic} onChange={(e) => set('topic', e.target.value)} placeholder="Why Mumbai's chai stalls open before sunrise, and who they serve" />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Audience" htmlFor="aud" hint="Optional.">
                  <Input id="aud" maxLength={200} value={brief.audience ?? ''} onChange={(e) => set('audience', e.target.value)} placeholder="College students in Mumbai" />
                </Field>
                <Field label="Language" htmlFor="lang">
                  <Select id="lang" value={brief.language} onChange={(e) => set('language', e.target.value)}>
                    {(catalogue?.languages ?? []).map((l) => (
                      <option key={l.code} value={l.code}>
                        {l.native === l.english ? l.english : `${l.native} · ${l.english}`}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            </div>
            <div className="mt-2 grid gap-5 sm:grid-cols-2">
              <div>
                <p className="mb-1.5 text-sm font-medium text-ink">Tone</p>
                <Segmented label="Tone" value={brief.tone} onChange={(v: Tone) => set('tone', v)} options={[{ id: 'friendly', label: 'Friendly' }, { id: 'expert', label: 'Expert' }, { id: 'bold', label: 'Bold' }, { id: 'story', label: 'Story' }]} />
              </div>
              <div>
                <p className="mb-1.5 text-sm font-medium text-ink">Goal</p>
                <Segmented label="Goal" value={brief.goal} onChange={(v: Goal) => set('goal', v)} options={[{ id: 'educate', label: 'Teach' }, { id: 'sell', label: 'Sell' }, { id: 'entertain', label: 'Entertain' }]} />
              </div>
              <div>
                <p className="mb-1.5 text-sm font-medium text-ink">Length</p>
                <Segmented label="Length" value={String(brief.seconds) as '15' | '30' | '45' | '60'} onChange={(v) => set('seconds', Number(v))} options={[{ id: '15', label: '15s' }, { id: '30', label: '30s' }, { id: '45', label: '45s' }, { id: '60', label: '60s' }]} />
              </div>
            </div>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Button variant="primary" busy={busy} disabled={brief.topic.trim().length < 3} onClick={writeHooks}>
                Write hooks
              </Button>
              <Link to="/app?new=1" className="text-sm text-ink-2 underline hover:text-ink">
                Start from a blank reel instead
              </Link>
            </div>
          </section>
        )}

        {step === 1 && (
          <section aria-labelledby="hooks">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 id="hooks" className="text-lg font-semibold text-ink">Pick the first line</h2>
              <Button size="sm" variant="ghost" busy={busy} onClick={writeHooks}>
                <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
                New hooks
              </Button>
            </div>
            {/* Locked while a new list is coming, which would replace the pick. */}
            <fieldset className={cx('space-y-2', busy && 'opacity-60')} disabled={busy}>
              <legend className="sr-only">Hooks</legend>
              {hooks.map((h) => (
                <label key={h.text} className={cx('flex cursor-pointer gap-3 rounded-lg border p-4 transition-colors', hook === h.text ? 'border-ink-3 bg-panel-2' : 'border-line bg-panel hover:bg-panel-2')}>
                  <input type="radio" name="hook" className="mt-1 h-3.5 w-3.5" checked={hook === h.text} onChange={() => setHook(h.text)} />
                  <span>
                    <span className="block text-base font-medium text-ink">{h.text}</span>
                    <span className="mt-0.5 block text-xs text-ink-3">{h.angle}</span>
                  </span>
                </label>
              ))}
              <label className={cx('flex gap-3 rounded-lg border p-4', !hooks.some((h) => h.text === hook) ? 'border-ink-3 bg-panel-2' : 'border-line bg-panel')}>
                <PenLine aria-hidden="true" className="mt-2.5 h-4 w-4 shrink-0 text-ink-3" />
                <Input aria-label="Your own hook" maxLength={200} placeholder="Or write your own first line" value={hooks.some((h) => h.text === hook) ? '' : hook} onChange={(e) => setHook(e.target.value)} />
              </label>
            </fieldset>
            <div className="mt-6 flex gap-3">
              <Button variant="ghost" onClick={() => setStep(0)}>
                <ArrowLeft aria-hidden="true" className="h-4 w-4" />
                Back
              </Button>
              <Button variant="primary" busy={busy} disabled={hook.trim().length < 3} onClick={writeScripts}>
                Write the script
              </Button>
            </div>
          </section>
        )}

        {step === 2 && version && (
          <section aria-labelledby="script">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 id="script" className="text-lg font-semibold text-ink">Shape the script</h2>
              <Button size="sm" variant="ghost" busy={busy} onClick={writeScripts}>
                <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
                New versions
              </Button>
            </div>
            {versions.length > 1 && (
              <div className="mb-4">
                <Segmented label="Versions" value={String(pick)} onChange={(v) => choose(versions, Number(v))} options={versions.map((v, i) => ({ id: String(i), label: v.title, title: v.title }))} />
              </div>
            )}
            {version.why && <p className="mb-4 max-w-prose text-sm text-ink-2">{version.why}</p>}
            {version.problems.length > 0 && (
              <ul className="mb-4 space-y-1 rounded-md bg-warn-soft px-4 py-3 text-xs text-warn">
                {version.problems.map((p, i) => (
                  <li key={i}>{p.blocking ? 'Fix before posting: ' : 'Check: '}{p.detail}</li>
                ))}
              </ul>
            )}
            <ol className="space-y-3">
              {scenes.map((s, i) => {
                // The accessible name is the visible one, so "Scene 1" said
                // aloud reaches the box marked Scene 1.
                const name = i === 0 ? 'Hook' : `Scene ${i}`;
                return (
                <li key={i} className="rounded-lg border border-line bg-panel p-4">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="text-xs font-semibold text-ink-2">{name}</span>
                    <span className="truncate text-2xs text-ink-3" title="Footage this scene looks for">{s.visual}</span>
                  </div>
                  {rewriting === i ? (
                    <Skeleton className="h-16 w-full" label="Rewriting" />
                  ) : (
                    <Textarea rows={2} aria-label={name} value={s.text} onChange={(e) => setScenes((list) => list.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)))} />
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {QUICK.map((q) => (
                      <Button key={q} size="xs" variant="ghost" disabled={busy} onClick={() => rewrite(i, q)}>
                        {q}
                      </Button>
                    ))}
                    {/* Its own row on a phone, where it would otherwise wrap in among the chips. */}
                    <span className="flex w-full gap-1.5 sm:ml-auto sm:w-auto">
                      <Input className="h-7 text-xs sm:w-48" placeholder="Or say how…" aria-label={`How to rewrite the ${name.toLowerCase()}`} value={custom[i] ?? ''} onChange={(e) => setCustom((c) => ({ ...c, [i]: e.target.value }))} />
                      <Button size="xs" disabled={busy || (custom[i] ?? '').trim().length < 2} onClick={() => rewrite(i, custom[i]!)}>
                        Rewrite
                      </Button>
                    </span>
                  </div>
                </li>
                );
              })}
              <li className="rounded-lg border border-dashed border-line-strong p-4">
                <span className="mb-2 block text-xs font-semibold text-ink-2">Call to action</span>
                <Input aria-label="Call to action" placeholder="Optional, for example: Follow for more" value={cta} onChange={(e) => setCta(e.target.value)} />
              </li>
            </ol>
            <p className="tabular mt-3 text-xs text-ink-3">
              {words} words · about {Math.round((words / 165) * 60)} seconds spoken
            </p>
            <div className="mt-6 flex gap-3">
              <Button variant="ghost" onClick={() => setStep(1)}>
                <ArrowLeft aria-hidden="true" className="h-4 w-4" />
                Back
              </Button>
              <Button variant="primary" onClick={() => setStep(3)}>
                Use this script
              </Button>
            </div>
          </section>
        )}

        {step === 3 && (
          <section className="rounded-lg border border-line bg-panel p-5 sm:p-6" aria-labelledby="create">
            <h2 id="create" className="text-lg font-semibold text-ink">Create the reel</h2>
            <div className="mt-4">
              <Field label="Title" htmlFor="title">
                <Input id="title" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
              </Field>
            </div>
            <dl className="grid grid-cols-3 gap-3 rounded-md bg-panel-2 p-4 text-sm">
              <div>
                <dt className="text-xs text-ink-3">Scenes</dt>
                <dd className="tabular font-medium text-ink">{scenes.length}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-3">Length</dt>
                <dd className="tabular font-medium text-ink">~{Math.round((words / 165) * 60)}s</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-3">Language</dt>
                <dd className="font-medium text-ink">{catalogue?.languages.find((l) => l.code === brief.language)?.english ?? brief.language}</dd>
              </div>
            </dl>
            <p className="mt-4 text-sm text-ink-2">
              The editor opens with this script in the Script panel. Add your footage, then press <Badge>Make the reel</Badge> to cut it into scenes matched to your clips.
            </p>
            <div className="mt-6 flex gap-3">
              <Button variant="ghost" onClick={() => setStep(2)}>
                <ArrowLeft aria-hidden="true" className="h-4 w-4" />
                Back
              </Button>
              <Button variant="primary" busy={busy} onClick={create}>
                <Clapperboard aria-hidden="true" className="h-4 w-4" />
                Create and open the editor
              </Button>
            </div>
          </section>
        )}
      </div>
    </AppShell>
  );
}
