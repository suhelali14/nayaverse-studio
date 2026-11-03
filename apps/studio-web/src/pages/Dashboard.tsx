import { Clapperboard, Plus, RefreshCw, Search, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, api, type Job, type Project, type Usage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { planOf, useCatalogue } from '../lib/catalogue';
import { AppShell } from '../components/chrome';
import { forgetMedia } from '../editor/mediaStore';
import { Badge, Button, Empty, Field, IconButton, Input, Panel, Select, Skeleton, cx, useToast } from '../components/ui';
import {
  Meter,
  ProjectCard,
  ProjectCardSkeleton,
  errorText,
  formatDate,
  isJobOpen,
} from '../components/project-card';

/**
 * The signed-in home: the reels library, what this period has used, and a
 * way to start the next reel.
 *
 * ── Polling, and why it is shaped like this ──────────────────────────
 *
 * Transcribing, dubbing and rendering all happen on a worker, so the only
 * way this page learns they finished is to ask. The naive version is a
 * `setInterval` mounted with the page, and it is the version that quietly
 * costs money: at one poll every four seconds, an idle dashboard left open
 * in a tab is 900 requests an hour, 21,600 a day, that nobody reads.
 *
 * So the loop is conditional on there being something to watch. It starts
 * only when a job is `queued` or `running`, skips the request entirely
 * while the tab is hidden, catches up the moment it is shown again, and
 * tears itself down both on unmount and on the last job finishing. When
 * nothing is in flight there is no timer at all -- not a timer that
 * returns early.
 *
 * It is a re-scheduled `setTimeout` rather than an interval because an
 * interval does not wait for the previous request: a slow API would get a
 * growing pile of overlapping polls, which is how a struggling server gets
 * pushed over.
 */

const POLL_MS = 4000;

const at = (iso: string): number => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
};

export default function Dashboard() {
  const { account } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  // `null` is "not loaded yet", which is a different thing from an empty
  // list, and the two get different screens.
  const [projects, setProjects] = useState<readonly Project[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<readonly Job[]>([]);
  const [query, setQuery] = useState('');

  const mounted = useRef(true);
  // Set on mount as well as cleared on unmount. React StrictMode mounts,
  // unmounts and remounts every component in development; a ref that is
  // only ever cleared stays false after that rehearsal, and every async
  // result is then dropped -- which left the dashboard on skeletons for
  // good and every async button spinning after it had finished.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      const next = await api.projects();
      if (!mounted.current) return;
      setProjects(next);
      setProjectsError(null);
    } catch (err) {
      if (!mounted.current) return;
      // The existing list is deliberately left in place: a failed refresh
      // should not blank out the projects someone is reading.
      setProjectsError(errorText(err));
    }
  }, []);

  const loadUsage = useCallback(async () => {
    try {
      const next = await api.usage();
      if (!mounted.current) return;
      setUsage(next);
      setUsageError(null);
    } catch (err) {
      if (!mounted.current) return;
      setUsageError(errorText(err));
    }
  }, []);

  const loadJobs = useCallback(async () => {
    try {
      const next = await api.jobs();
      if (mounted.current) setJobs(next);
    } catch {
      // Jobs annotate the reels rather than carry them. A failure here costs
      // a progress bar, so it is not worth a banner or a toast.
    }
  }, []);

  useEffect(() => {
    void loadProjects();
    void loadUsage();
    void loadJobs();
  }, [loadProjects, loadUsage, loadJobs]);

  const watching = jobs.some(isJobOpen);

  useEffect(() => {
    if (!watching) return;

    let alive = true;
    let timer: number | undefined;

    const schedule = (ms: number) => {
      if (timer !== undefined) clearTimeout(timer);
      timer = window.setTimeout(() => void tick(), ms);
    };

    const tick = async () => {
      if (!alive) return;
      if (document.visibilityState !== 'visible') {
        // A hidden tab is billed for every poll and shows nobody the
        // answer. `onShown` below catches it up immediately.
        schedule(POLL_MS);
        return;
      }
      try {
        const next = await api.jobs();
        if (!alive) return;
        setJobs(next);
        // A job finishing is what changes a project's status, its duration
        // and the usage counters, so those are re-read once here rather
        // than polled alongside the jobs.
        if (!next.some(isJobOpen)) {
          void loadProjects();
          void loadUsage();
        }
      } catch {
        // One dropped poll is not news. The next one may well work, and if
        // the server is gone the project list already says so.
      }
      if (alive) schedule(POLL_MS);
    };

    const onShown = () => {
      if (document.visibilityState === 'visible') schedule(0);
    };

    document.addEventListener('visibilitychange', onShown);
    schedule(POLL_MS);

    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onShown);
    };
  }, [watching, loadProjects, loadUsage]);

  // ── Creating a reel ─────────────────────────────────────────────────

  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const { catalogue } = useCatalogue();
  // The footage language defaults to the catalogue's first, which leads
  // with Hindi because this product's market does; until the catalogue
  // arrives it is English, which every list contains.
  const [language, setLanguage] = useState('en');
  useEffect(() => {
    const first = catalogue?.languages[0]?.code;
    if (first) setLanguage((current) => (current === 'en' ? first : current));
  }, [catalogue]);
  const [titleError, setTitleError] = useState<string | null>(null);
  /** The reel just created, which can take a recording before opening. */
  const [draft, setDraft] = useState<Project | null>(null);
  const [uploading, setUploading] = useState(false);
  const [over, setOver] = useState(false);

  const startNew = useCallback(() => {
    setDraft(null);
    setTitleError(null);
    setCreating(true);
  }, []);

  // The wizard's "Start from a blank reel" lands here with ?new=1.
  useEffect(() => {
    if (params.get('new') !== '1') return;
    startNew();
    const next = new URLSearchParams(params);
    next.delete('new');
    setParams(next, { replace: true });
  }, [params, setParams, startNew]);

  const create = async () => {
    const trimmed = title.trim();
    if (trimmed === '') {
      setTitleError('Give it a title, so you can find it again.');
      return;
    }
    try {
      const made = await api.createProject({ title: trimmed, language });
      if (!mounted.current) return;
      setTitle('');
      setTitleError(null);
      setDraft(made);
      await Promise.all([loadProjects(), loadUsage()]);
    } catch (err) {
      if (!mounted.current) return;
      const text = errorText(err);
      // The server says which field it objected to; putting the message
      // under that field beats a toast the user has to map back.
      if (err instanceof ApiError && err.field === 'title') setTitleError(text);
      else toast(text, 'bad');
    }
  };

  const upload = async (file: File | undefined) => {
    // A second drop mid-upload would race the first; the file input is
    // disabled meanwhile, but a drop does not go through the input.
    if (draft === null || file === undefined || uploading) return;
    // An empty type is allowed through, because some .mov files report no
    // MIME type at all.
    if (file.type !== '' && !file.type.startsWith('video/')) {
      toast(file.name + ' is not a video file.', 'bad');
      return;
    }
    setUploading(true);
    try {
      await api.uploadFootage(draft.id, file);
      if (!mounted.current) return;
      toast('Recording added to ' + draft.title + '.');
      setDraft(null);
      setCreating(false);
      await Promise.all([loadProjects(), loadJobs(), loadUsage()]);
    } catch (err) {
      if (mounted.current) toast(errorText(err), 'bad');
    } finally {
      if (mounted.current) setUploading(false);
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(false);
    // One project is one reel, so only the first file is used.
    void upload(e.dataTransfer.files[0]);
  };

  const remove = async (project: Project) => {
    try {
      await api.deleteProject(project.id);
      // The reel's media kept in this browser goes with it.
      void forgetMedia(project.id);
      if (!mounted.current) return;
      toast(project.title + ' deleted.');
      await Promise.all([loadProjects(), loadUsage()]);
    } catch (err) {
      if (mounted.current) toast(errorText(err), 'bad');
    }
  };

  // ── Derived views of the data ───────────────────────────────────────

  const byProject = useMemo(() => {
    const map = new Map<string, Job[]>();
    for (const job of jobs) {
      const list = map.get(job.projectId);
      if (list === undefined) map.set(job.projectId, [job]);
      else list.push(job);
    }
    return map;
  }, [jobs]);

  const ordered = useMemo(() => {
    if (projects === null) return null;
    // Anything broken or in flight first, newest after. The tile that needs
    // a human is the tile that should not need scrolling to.
    const rank = (p: Project): number => {
      const own = byProject.get(p.id) ?? [];
      if (p.status === 'failed' || own.some((j) => j.status === 'failed')) return 0;
      if (own.some(isJobOpen)) return 1;
      return 2;
    };
    return [...projects].sort((a, b) => rank(a) - rank(b) || at(b.updatedAt) - at(a.updatedAt));
  }, [projects, byProject]);

  const needle = query.trim().toLowerCase();
  const visible = ordered === null ? null : needle === '' ? ordered : ordered.filter((p) => p.title.toLowerCase().includes(needle));

  const plan = catalogue ? planOf(catalogue, account?.planId ?? null) : undefined;

  return (
    <AppShell
      title="Reels"
      actions={
        <>
          <IconButton
            label="Refresh"
            small
            onClick={() => Promise.all([loadProjects(), loadUsage(), loadJobs()])}
          >
            <RefreshCw aria-hidden="true" className="h-4 w-4" />
          </IconButton>
          {/* The sidebar carries New reel on a desk; a phone has no sidebar. */}
          <Button variant="primary" size="sm" className="lg:hidden" onClick={() => navigate('/app/new')}>
            <Plus aria-hidden="true" className="h-4 w-4" />
            New reel
          </Button>
        </>
      }
    >
      {account?.paidThrough && account.paidThrough <= new Date().toISOString() && (
        <div role="status" className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-bad/40 bg-bad-soft px-4 py-3">
          <p className="text-sm text-ink">
            Your plan ended on {formatDate(account.paidThrough)}. Renew it to keep creating reels.
          </p>
          <Link to="/app/billing" tabIndex={-1}>
            <Button size="sm" variant="primary">
              Renew
            </Button>
          </Link>
        </div>
      )}

      {/* ── New reel ─────────────────────────────────────────────────── */}

      {creating && (
        <Panel as="section" className="mb-8" tab={draft === null ? 'New reel' : draft.title}>
          <div className="p-5">
            {draft === null ? (
              <form
                className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_220px_auto] sm:items-start"
                onSubmit={(e) => {
                  e.preventDefault();
                  void create();
                }}
              >
                <Field label="Title" htmlFor="new-title" error={titleError}>
                  <Input
                    id="new-title"
                    // The form only exists because someone just asked for a
                    // new reel, so the caret belongs in it.
                    autoFocus
                    value={title}
                    invalid={titleError !== null}
                    maxLength={120}
                    placeholder="Monsoon skincare routine"
                    onChange={(e) => {
                      setTitle(e.target.value);
                      if (titleError !== null) setTitleError(null);
                    }}
                  />
                </Field>

                <Field label="Spoken language" htmlFor="new-language">
                  <Select id="new-language" value={language} onChange={(e) => setLanguage(e.target.value)}>
                    {(catalogue?.languages ?? []).map((l) => (
                      <option key={l.code} value={l.code}>
                        {l.english} ({l.native})
                      </option>
                    ))}
                  </Select>
                </Field>

                <div className="flex gap-2 sm:mt-7">
                  <Button variant="primary" onClick={() => create()}>
                    Create
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setCreating(false);
                      setTitleError(null);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                {/*
                  A drop target, and also a real file input. The input is
                  `sr-only` rather than hidden, so it keeps its place in the
                  tab order, and the label carries the focus ring on its
                  behalf through `peer-focus-visible`.
                */}
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setOver(true);
                  }}
                  onDragLeave={(e) => {
                    const to = e.relatedTarget;
                    if (!(to instanceof Node) || !e.currentTarget.contains(to)) setOver(false);
                  }}
                  onDrop={onDrop}
                  className={cx(
                    'flex flex-col items-center rounded-lg border border-dashed px-6 py-8 text-center transition-colors',
                    over ? 'border-accent bg-accent-soft' : 'border-line-strong',
                  )}
                >
                  <Upload aria-hidden="true" className="h-5 w-5 text-ink-3" />
                  <p className="mt-2 text-sm text-ink">Add a recording to transcribe and cut</p>
                  <input
                    id="footage"
                    type="file"
                    accept="video/*"
                    disabled={uploading}
                    className="peer sr-only"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      // Cleared so choosing the same file twice still fires.
                      e.target.value = '';
                      void upload(file);
                    }}
                  />
                  <label
                    htmlFor="footage"
                    className={cx(
                      'mt-3 inline-flex h-9 cursor-pointer items-center rounded-md border border-line-strong bg-panel-2 px-4 text-sm font-medium text-ink hover:bg-panel-3',
                      'peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-select',
                      'peer-disabled:cursor-not-allowed peer-disabled:opacity-45',
                    )}
                  >
                    Choose a video
                  </label>
                  <p className="mt-2 text-xs text-ink-3">MP4 or MOV, or drop it here</p>
                  {uploading && (
                    <p role="status" aria-live="polite" className="mt-3 text-xs text-ink-2">
                      Uploading. Keep this tab open until it finishes.
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 md:flex-col">
                  <Button variant="primary" onClick={() => navigate('/app/p/' + draft.id)}>
                    <Clapperboard aria-hidden="true" className="h-4 w-4" />
                    Open in editor
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setDraft(null);
                      setCreating(false);
                    }}
                  >
                    Done
                  </Button>
                </div>
              </div>
            )}
          </div>
        </Panel>
      )}

      {/* ── Usage ────────────────────────────────────────────────────── */}

      <section aria-label="Usage this period" className="mb-8 rounded-lg border border-line bg-panel">
        {usage === null && usageError === null && <UsageSkeleton />}
        {usage === null && usageError !== null && (
          <div className="flex flex-wrap items-center justify-between gap-3 p-4">
            <p className="text-sm text-ink-2">Usage couldn't be loaded. {usageError}</p>
            <Button size="sm" onClick={() => loadUsage()}>
              Try again
            </Button>
          </div>
        )}
        {usage !== null && (
          <div className="grid gap-x-8 gap-y-5 p-5 md:grid-cols-[minmax(0,200px)_minmax(0,1fr)_minmax(0,1fr)]">
            <div>
              <p className="text-sm font-semibold text-ink">{plan ? plan.name + ' plan' : 'No plan'}</p>
              <p className="mt-1 text-xs text-ink-3">
                {formatDate(usage.periodStart)} – {formatDate(usage.periodEnd)}
              </p>
              <Link to="/app/billing" className="mt-2 inline-block text-xs font-medium text-ink-2 underline hover:text-ink">
                Manage plan
              </Link>
            </div>
            <Meter
              label="Reels"
              readout={usage.reelsUsed + ' / ' + usage.reelsIncluded}
              value={usage.reelsUsed}
              max={usage.reelsIncluded}
              note={
                usage.reelsUsed > usage.reelsIncluded
                  ? usage.reelsUsed - usage.reelsIncluded + ' over the plan allowance'
                  : Math.max(0, usage.reelsIncluded - usage.reelsUsed) + ' left'
              }
            />
            <div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm text-ink-2">Dubbing</span>
                <Badge tone="warn">Coming soon</Badge>
              </div>
              <p className="mt-2 text-xs text-ink-3">Your plan's minutes start when dubbing launches.</p>
            </div>
            {usageError !== null && (
              <p className="text-xs text-warn md:col-span-3">These numbers may be out of date: {usageError}</p>
            )}
          </div>
        )}
      </section>

      {/* ── Reels ────────────────────────────────────────────────────── */}

      <section aria-labelledby="reels-heading">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 id="reels-heading" className="text-sm font-semibold text-ink">
            All reels {projects !== null && <span className="font-normal text-ink-3">· {projects.length}</span>}
          </h2>
          {projects !== null && projects.length > 0 && (
            <label className="relative block w-full sm:w-64">
              <span className="sr-only">Search reels</span>
              <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search reels"
                className="h-8 pl-8 pr-8"
              />
              {query !== '' && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setQuery('')}
                  className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-ink-3 hover:text-ink"
                >
                  <X aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              )}
            </label>
          )}
        </div>

        {projectsError !== null && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-line-strong bg-panel-2 px-3 py-2">
            <p className="text-xs text-warn">
              {ordered === null ? "Your reels couldn't be loaded" : 'This list may be out of date'}: {projectsError}
            </p>
            <Button size="xs" onClick={() => loadProjects()}>
              Retry
            </Button>
          </div>
        )}

        {visible === null && projectsError === null && (
          <>
            <p role="status" className="sr-only">
              Loading your reels
            </p>
            <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {[0, 1, 2, 3, 4].map((i) => (
                <ProjectCardSkeleton key={i} />
              ))}
            </ul>
          </>
        )}

        {visible !== null && ordered !== null && ordered.length === 0 && (
          <Empty
            icon={<Clapperboard aria-hidden="true" className="h-5 w-5" />}
            title="Make your first reel"
            body="Write or paste a script and Studio splits it into scenes, matches your clips and captions every word."
            action={
              <div className="flex flex-wrap items-center justify-center gap-3">
                <Button variant="primary" onClick={() => navigate('/app/new')}>
                  <Plus aria-hidden="true" className="h-4 w-4" />
                  New reel
                </Button>
                <Button variant="ghost" onClick={startNew}>
                  Start blank
                </Button>
              </div>
            }
          />
        )}

        {visible !== null && ordered !== null && ordered.length > 0 && visible.length === 0 && (
          <p className="py-10 text-center text-sm text-ink-3">No reels match “{query.trim()}”.</p>
        )}

        {visible !== null && visible.length > 0 && (
          <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {visible.map((p) => (
              <ProjectCard key={p.id} project={p} jobs={byProject.get(p.id) ?? []} onDelete={() => remove(p)} />
            ))}
          </ul>
        )}
      </section>
    </AppShell>
  );
}

/** The same rows, the same heights, so nothing jumps when usage lands. */
function UsageSkeleton() {
  return (
    <div className="grid gap-x-8 gap-y-5 p-5 md:grid-cols-[minmax(0,200px)_minmax(0,1fr)_minmax(0,1fr)]" aria-hidden="true">
      <div>
        <Skeleton className="h-4 w-28" label="Loading usage" />
        <Skeleton className="mt-2 h-3 w-36" />
      </div>
      {[0, 1].map((i) => (
        <div key={i}>
          <div className="flex justify-between">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-14" />
          </div>
          <Skeleton className="mt-2 h-1.5 w-full" />
          <Skeleton className="mt-1.5 h-3 w-24" />
        </div>
      ))}
    </div>
  );
}
