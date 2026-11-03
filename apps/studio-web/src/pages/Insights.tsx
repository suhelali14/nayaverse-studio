import { ArrowRight, Link2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '../components/chrome';
import { PlatformMark } from '../components/platform-mark';
import { Button, Empty, Segmented, Skeleton, cx } from '../components/ui';
import { errorText, formatDate } from '../components/project-card';
import { api, type InsightsReport, type PlatformInfo, type SocialPlatform } from '../lib/api';

/**
 * What the creator's own posts say. Every number here is computed by
 * `buildReport` in the engine from synced posts, and every comparison is
 * against the creator's own median -- see the rules in
 * `apps/studio/src/lib/insights.ts`.
 */

// One notation for every figure on the page: "1L" beside "50K" on one axis
// reads as two units.
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const n = (v: number | null) => (v === null ? '—' : compact.format(v));

/** A round number at or above `max`, so gridlines land on readable values. */
function niceCeiling(max: number): number {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= max) return m * p;
  return 10 * p;
}

function WeeklyChart({ weeks }: { weeks: InsightsReport['weekly'] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (weeks.length === 0) return <p className="py-10 text-center text-sm text-ink-3">No posts in this period.</p>;
  const top = niceCeiling(Math.max(...weeks.map((w) => w.views)));
  const grid = [top, top / 2, 0];
  // Every week ticked when there are few; every other one when crowded.
  const every = weeks.length > 8 ? 2 : 1;
  return (
    <figure className="m-0">
      <div className="grid grid-cols-[2.75rem_minmax(0,1fr)] gap-2">
        <div className="relative h-52 text-right text-2xs text-ink-3" aria-hidden="true">
          {grid.map((g) => (
            <span key={g} className="tabular absolute right-0 -translate-y-1/2" style={{ top: `${(1 - g / top) * 100}%` }}>
              {compact.format(g)}
            </span>
          ))}
        </div>
        <div className="relative h-52">
          {grid.map((g) => (
            <span
              key={g}
              aria-hidden="true"
              className="absolute inset-x-0 border-t border-line"
              style={{ top: `${(1 - g / top) * 100}%` }}
            />
          ))}
          <div className="relative flex h-full items-end gap-1.5" role="img" aria-label="Views per week">
            {weeks.map((w, i) => (
              <div
                key={w.weekStart}
                className="relative flex h-full flex-1 items-end"
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
              >
                <div
                  className={cx('w-full rounded-t-[4px] transition-colors', hover === i ? 'bg-accent' : 'bg-ink-3/70')}
                  style={{ height: `${Math.max(1.5, (w.views / top) * 100)}%` }}
                />
                {hover === i && (
                  <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md border border-line-strong bg-panel-2 px-2.5 py-1.5 text-xs shadow-float">
                    <p className="font-semibold text-ink">{w.views.toLocaleString('en-IN')} views</p>
                    <p className="text-ink-3">
                      Week of {formatDate(w.weekStart)} · {w.posts} {w.posts === 1 ? 'post' : 'posts'}
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
        <span aria-hidden="true" />
        <div className="flex gap-1.5 text-2xs text-ink-3" aria-hidden="true">
          {weeks.map((w, i) => (
            <span key={w.weekStart} className="min-w-0 flex-1 truncate text-center">
              {i % every === 0 ? new Date(w.weekStart).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : ''}
            </span>
          ))}
        </div>
      </div>
    </figure>
  );
}

function LiftBars({ items, empty, wide }: { items: InsightsReport['topics']; empty: string; wide?: boolean }) {
  if (items.length === 0) return <p className="text-sm text-ink-3">{empty}</p>;
  const max = Math.max(2, ...items.map((t) => t.lift));
  return (
    <ul className="space-y-2.5">
      {items.map((t) => (
        <li
          key={t.label}
          className={cx(
            'grid items-center gap-3 text-sm',
            // On a phone the label takes the room and the bar keeps a fixed width.
            wide
              ? 'grid-cols-[minmax(0,1fr)_5rem_3rem] sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_3rem]'
              : 'grid-cols-[minmax(0,1fr)_5rem_3rem] sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)_3rem]',
          )}
        >
          <span className="truncate text-ink" title={t.label}>
            {t.label}
          </span>
          <span className="relative h-2 rounded-full bg-panel-3" aria-hidden="true">
            {/* The 1× mark: the creator's usual. Bars past it are above it. */}
            <span className="absolute inset-y-[-3px] w-px bg-ink-3" style={{ left: `${(1 / max) * 100}%` }} />
            <span
              className={cx('absolute inset-y-0 left-0 rounded-full', t.lift >= 1 ? 'bg-good' : 'bg-ink-3')}
              style={{ width: `${Math.min(100, (t.lift / max) * 100)}%` }}
            />
          </span>
          <span className="tabular text-right text-xs text-ink-2" title={`${t.posts} posts, median ${t.medianViews.toLocaleString('en-IN')} views`}>
            {t.lift.toFixed(1)}×
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Median views per slot, with the best one marked -- length, or weekday. */
function SlotBars({ title, items }: { title: string; items: InsightsReport['days'] }) {
  if (items.length === 0) return null;
  const max = Math.max(...items.map((s) => s.medianViews));
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold text-ink">{title}</h3>
      <ul className="space-y-1.5">
        {items.map((s) => {
          const best = s.medianViews === max;
          return (
            <li key={s.label} className="grid grid-cols-[4.5rem_minmax(0,1fr)_3rem] items-center gap-2 text-xs">
              <span className={best ? 'font-semibold text-ink' : 'text-ink-2'}>{s.label}</span>
              <span className="h-1.5 rounded-full bg-panel-3" aria-hidden="true">
                <span
                  className={cx('block h-full rounded-full', best ? 'bg-good' : 'bg-ink-3')}
                  style={{ width: `${(s.medianViews / max) * 100}%` }}
                />
              </span>
              <span className={cx('tabular text-right', best ? 'text-ink' : 'text-ink-3')}>{n(s.medianViews)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}


export default function Insights() {
  const [platforms, setPlatforms] = useState<PlatformInfo[] | null>(null);
  const [filter, setFilter] = useState<SocialPlatform | 'all'>('all');
  const [report, setReport] = useState<InsightsReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.connections().then((r) => setPlatforms(r.platforms), (e) => setError(errorText(e)));
  }, []);

  useEffect(() => {
    setReport(null);
    api.insights(filter).then((r) => setReport(r.report), (e) => setError(errorText(e)));
  }, [filter]);

  const connected = platforms?.filter((p) => p.connection !== null) ?? [];

  return (
    <AppShell
      title="Insights"
      actions={
        <Link to="/app/ideas" tabIndex={-1}>
          <Button variant="primary" size="sm">
            Get ideas
            <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </Button>
        </Link>
      }
    >
      {error && <p className="mb-4 rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">{error}</p>}

      {platforms !== null && connected.length === 0 ? (
        <Empty
          icon={<Link2 aria-hidden="true" className="h-5 w-5" />}
          title="Connect an account to see your insights"
          body="Studio reads your posts and their numbers, then shows which topics, openers, lengths and days work for you."
          action={
            <Link to="/app/connections" tabIndex={-1}>
              <Button variant="primary">Connect an account</Button>
            </Link>
          }
        />
      ) : (
        <div className="space-y-6">
          {connected.length > 1 && (
            <div className="max-w-md">
              <Segmented
                label="Platform"
                value={filter}
                onChange={setFilter}
                options={[{ id: 'all' as const, label: 'All' }, ...connected.map((p) => ({ id: p.id, label: p.name }))]}
              />
            </div>
          )}

          {report === null ? (
            <div className="space-y-4" aria-hidden="true">
              <Skeleton className="h-20 w-full" label="Loading insights" />
              <Skeleton className="h-56 w-full" />
            </div>
          ) : (
            <>
              {/* The headline numbers, as one strip rather than four cards. */}
              <dl className="grid grid-cols-2 divide-line overflow-hidden rounded-lg border border-line bg-panel md:grid-cols-4 md:divide-x">
                {[
                  ['Posts', String(report.posts), `last ${report.windowDays} days`],
                  [
                    'Median views',
                    n(report.medianViews),
                    report.trend === null
                      ? 'per post'
                      : `${report.trend >= 0 ? '+' : ''}${Math.round(report.trend * 100)}% vs the 30 days before`,
                  ],
                  ['Engagement', report.medianEngagement === null ? '—' : (report.medianEngagement * 100).toFixed(1) + '%', 'median, per view'],
                  ['Posts a week', String(report.postsPerWeek), 'last 4 weeks'],
                ].map(([label, value, note]) => (
                  <div key={label} className="border-line p-4 [&:nth-child(-n+2)]:border-b md:[&:nth-child(-n+2)]:border-b-0">
                    <dt className="text-xs text-ink-3">{label}</dt>
                    <dd className="tabular mt-1 text-xl font-semibold tracking-[-0.02em] text-ink">{value}</dd>
                    <dd className="text-2xs text-ink-3">{note}</dd>
                  </div>
                ))}
              </dl>

              <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                <section className="rounded-lg border border-line bg-panel p-5" aria-labelledby="weekly">
                  <h2 id="weekly" className="mb-4 text-sm font-semibold text-ink">
                    Views per week
                  </h2>
                  <WeeklyChart weeks={report.weekly} />
                </section>

                <section className="rounded-lg border border-line bg-panel p-5" aria-labelledby="findings">
                  <h2 id="findings" className="mb-3 text-sm font-semibold text-ink">
                    What your numbers say
                  </h2>
                  <ul className="space-y-3">
                    {report.findings.map((f, i) => (
                      <li key={i}>
                        <p className="text-sm font-medium text-ink">{f.text}</p>
                        <p className="mt-0.5 text-xs text-ink-3">{f.evidence}</p>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>

              <div className="grid gap-6 lg:grid-cols-2">
                <section className="rounded-lg border border-line bg-panel p-5" aria-labelledby="topics">
                  <h2 id="topics" className="text-sm font-semibold text-ink">
                    Topics
                  </h2>
                  <p className="mb-4 mt-0.5 text-xs text-ink-3">Topics that move your views 15% or more either way. The line is your usual.</p>
                  <LiftBars items={report.topics.slice(0, 8)} empty="Not enough posts on any one topic yet." />
                </section>
                <section className="rounded-lg border border-line bg-panel p-5" aria-labelledby="hooks">
                  <h2 id="hooks" className="text-sm font-semibold text-ink">
                    Opening lines
                  </h2>
                  <p className="mb-4 mt-0.5 text-xs text-ink-3">Posts with each pattern against those without it.</p>
                  <LiftBars wide items={report.hooks} empty="Not enough posts to compare openers yet." />
                  {(report.lengths.length > 0 || report.days.length > 0) && (
                    <div className="mt-5 grid gap-5 border-t border-line pt-4 sm:grid-cols-2">
                      <SlotBars title="By length" items={report.lengths} />
                      <SlotBars title="By day" items={report.days.map((d) => ({ ...d, label: d.label.slice(0, 3) }))} />
                    </div>
                  )}
                </section>
              </div>

              <section aria-labelledby="top">
                <h2 id="top" className="mb-3 text-sm font-semibold text-ink">
                  Top posts
                </h2>
                {report.top.length === 0 ? (
                  <p className="text-sm text-ink-3">No posts with view counts in this period.</p>
                ) : (
                  <ol className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel">
                    <li className="hidden grid-cols-[minmax(0,1fr)_8rem_5rem_5rem] gap-4 bg-panel-2 px-4 py-2.5 text-xs font-semibold text-ink-2 sm:grid" aria-hidden="true">
                      <span>Opening line</span>
                      <span>Posted</span>
                      <span className="text-right">Views</span>
                      <span className="text-right">vs usual</span>
                    </li>
                    {report.top.map((t) => (
                      <li key={t.platform + t.id} className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_8rem_5rem_5rem] sm:items-center sm:gap-4 sm:py-2.5">
                        <span className="flex min-w-0 items-center gap-2">
                          <PlatformMark platform={t.platform} className="h-4 w-4 text-ink-3" />
                          {t.url ? (
                            <a href={t.url} target="_blank" rel="noreferrer" className="truncate text-ink hover:underline">
                              {t.hook || '(no caption)'}
                            </a>
                          ) : (
                            <span className="truncate text-ink">{t.hook || '(no caption)'}</span>
                          )}
                        </span>
                        <span className="text-xs text-ink-3 sm:text-sm sm:text-ink-2">
                          {formatDate(t.publishedAt)}
                          <span className="sm:hidden">
                            {' · '}
                            {n(t.views)} views · {t.index === null ? '—' : t.index.toFixed(1) + '×'}
                          </span>
                        </span>
                        <span className="tabular hidden text-right text-ink sm:block">{n(t.views)}</span>
                        <span className={cx('tabular hidden text-right sm:block', (t.index ?? 0) >= 1 ? 'text-good' : 'text-ink-2')}>
                          {t.index === null ? '—' : t.index.toFixed(1) + '×'}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </>
          )}
        </div>
      )}
    </AppShell>
  );
}
