import { Download, Film, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useContextMenu } from './ContextMenu';
import { ApiError, apiAsset, type Job, type JobKind, type Project, type ProjectStatus } from '../lib/api';
import { languageOf, useCatalogue, type Catalogue } from '../lib/catalogue';
import { Badge, Button, Skeleton, Spinner, cx } from './ui';

/**
 * One reel, as a tile in the library -- plus the meter and the formatters
 * that the dashboard and the billing screen both need.
 *
 * They live together because each of them is a *rule*, not a helper: a date
 * rendered two ways on two screens is two rules, and the second one is
 * always the one nobody updated. The meter is here for the same reason --
 * its ARIA wiring and its "when does a bar turn amber" threshold are one
 * decision, and copying them into the billing page would be copying a
 * decision.
 */

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent';

// ---------------------------------------------------------------------------
// Formatters.

const dateOnly = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

const parse = (iso: string): number => {
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? Number.NaN : ms;
};

/** A date a person can read. An ISO string shown to a user is a bug. */
export function formatDate(iso: string): string {
  const ms = parse(iso);
  return Number.isNaN(ms) ? 'unknown' : dateOnly.format(ms);
}

export function formatDateTime(iso: string): string {
  const ms = parse(iso);
  return Number.isNaN(ms) ? 'unknown' : dateTime.format(ms);
}

/**
 * "3 minutes ago" near the event, an absolute date once it is old. Past a
 * week, "nine days ago" is harder to place than the date itself.
 */
export function formatWhen(iso: string): string {
  const ms = parse(iso);
  if (Number.isNaN(ms)) return 'at an unknown time';
  const sec = Math.round((ms - Date.now()) / 1000);
  const abs = Math.abs(sec);
  if (abs < 45) return 'just now';
  if (abs < 3600) return relative.format(Math.round(sec / 60), 'minute');
  if (abs < 86_400) return relative.format(Math.round(sec / 3600), 'hour');
  if (abs < 7 * 86_400) return relative.format(Math.round(sec / 86_400), 'day');
  return 'on ' + formatDate(iso);
}

/** Reels are short, so m:ss reads better than "38 seconds". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const whole = Math.round(seconds);
  const mins = Math.floor(whole / 60);
  const rest = String(whole % 60).padStart(2, '0');
  return mins + ':' + rest;
}

/** Dubbing is sold by the minute but metered in seconds. */
export function formatMinutes(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 min';
  const mins = seconds / 60;
  const text = mins < 10 ? mins.toFixed(1).replace(/\.0$/, '') : String(Math.round(mins));
  return text + ' min';
}

/**
 * A language code as its English name. An unknown code is shown as-is
 * rather than hidden: the API is allowed to know a language this list
 * does not.
 */
export function languageName(catalogue: Catalogue | null, code: string): string {
  const match = catalogue ? languageOf(catalogue, code) : undefined;
  return match?.english ?? code.toUpperCase();
}

/**
 * The text to put in front of a user when a call fails.
 *
 * An `ApiError` already carries the server's own words, which are almost
 * always more useful than anything a screen could invent. Everything else
 * is a transport failure, so say that, and still show the underlying
 * message rather than swallowing it.
 */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  const detail = err instanceof Error && err.message !== '' ? ' (' + err.message + ')' : '';
  return 'Could not reach the server.' + detail;
}

// ---------------------------------------------------------------------------
// The meter, shared by usage and by job progress.

const BAR: Record<'accent' | 'warn' | 'bad' | 'good', string> = {
  accent: 'bg-accent',
  warn: 'bg-warn',
  bad: 'bg-bad',
  good: 'bg-good',
};

export function Meter({
  label,
  readout,
  value,
  max,
  tone,
  note,
}: {
  label: string;
  /** Formatted for a human: "12 of 60 reels". Also the accessible value. */
  readout: string;
  value: number;
  max: number;
  tone?: 'accent' | 'warn' | 'bad' | 'good';
  note?: string;
}) {
  const ratio = max > 0 ? value / max : 0;
  // One threshold for every meter in the app. A bar changes colour when the
  // number it reports is actually a problem; paint 40% amber and the colour
  // stops carrying information at all.
  const fill = BAR[tone ?? (ratio > 1 ? 'bad' : ratio >= 0.9 ? 'warn' : 'accent')];
  const pct = Math.max(0, Math.min(1, ratio)) * 100;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-ink-2">{label}</span>
        <span className="text-sm tabular-nums text-ink">{readout}</span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max > 0 ? max : 0}
        aria-valuenow={value}
        aria-valuetext={readout}
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-panel-3"
      >
        {/* A computed width has to be inline. The colour never is. */}
        <div
          className={cx('h-full rounded-full transition-[width] duration-500', fill)}
          style={{ width: pct + '%' }}
        />
      </div>
      {note !== undefined && note !== '' && <p className="mt-1.5 text-xs text-ink-3">{note}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status and jobs.

/**
 * Only two states are exceptions: a render in flight, and a failure. The
 * other four are the ordinary life of a project, and a grid where every
 * tile wears a coloured pill is a grid where the one broken tile is
 * invisible.
 */
const STATUS: Record<ProjectStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  editing: { label: 'Editing', tone: 'neutral' },
  rendering: { label: 'Rendering', tone: 'accent' },
  ready: { label: 'Ready', tone: 'good' },
  published: { label: 'Published', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'bad' },
};

const KIND: Record<JobKind, string> = {
  transcribe: 'Transcribing',
  dub: 'Dubbing',
  render: 'Rendering',
};

export const jobLabel = (job: Job, catalogue: Catalogue | null): string =>
  job.kind === 'dub' && job.language !== undefined
    ? 'Dubbing into ' + languageName(catalogue, job.language)
    : KIND[job.kind];

export const isJobOpen = (job: Job): boolean => job.status === 'queued' || job.status === 'running';

/** One queued, running or failed job, under the reel it belongs to. */
function JobLine({ job }: { job: Job }) {
  const { catalogue } = useCatalogue();
  if (job.status === 'failed') {
    return (
      <p className="truncate text-2xs text-bad" title={job.message ?? undefined}>
        {jobLabel(job, catalogue)} failed{job.message !== null ? ': ' + job.message : ''}
      </p>
    );
  }
  const pct = job.progress === null ? null : Math.round(Math.max(0, Math.min(1, job.progress)) * 100);
  return (
    // One live region per job, holding the stage and the percentage and
    // nothing else, so a poll does not re-read the whole tile.
    <div role="status" aria-live="polite">
      <p className="flex items-center gap-1.5 text-2xs text-ink-2">
        <Spinner className="h-3 w-3" />
        <span className="truncate">
          {jobLabel(job, catalogue)}
          {job.status === 'queued' ? ' · queued' : pct !== null ? ` · ${pct}%` : ''}
        </span>
      </p>
      {pct !== null && (
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-panel-3" aria-hidden="true">
          <div className="h-full rounded-full bg-accent" style={{ width: pct + '%' }} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function ProjectCard({
  project,
  jobs,
  onDelete,
}: {
  project: Project;
  /** Only this project's jobs. The parent groups them; the card renders. */
  jobs: readonly Job[];
  onDelete: () => Promise<void>;
}) {
  const { catalogue } = useCatalogue();
  const [confirming, setConfirming] = useState(false);
  const status = STATUS[project.status];
  const shown = jobs.filter((j) => isJobOpen(j) || j.status === 'failed');
  const broken = project.status === 'failed' || shown.some((j) => j.status === 'failed');
  const name = project.title === '' ? 'Untitled reel' : project.title;
  const navigate = useNavigate();
  const openMenu = useContextMenu();
  const href = '/app/p/' + project.id;

  return (
    <li
      className="group"
      onContextMenu={(e) =>
        openMenu(
          e,
          [
            { label: 'Open', shortcut: 'Enter', onSelect: () => navigate(href) },
            { label: 'Open in a new tab', onSelect: () => window.open(href, '_blank', 'noopener') },
            { kind: 'separator' },
            // Into the card's own confirmation: a menu is no place to delete a reel outright.
            { label: 'Delete…', danger: true, onSelect: () => setConfirming(true) },
          ],
          name,
        )
      }
    >
      <div className={cx('relative overflow-hidden rounded-lg bg-panel-2 ring-1 ring-inset', broken ? 'ring-bad/60' : 'ring-line')}>
        <Link to={'/app/p/' + project.id} aria-label={'Open ' + name} className="block aspect-[4/5]">
          {project.thumbnailUrl === null ? (
            <span className="flex h-full w-full items-center justify-center text-ink-3">
              <Film aria-hidden="true" className="h-6 w-6" />
            </span>
          ) : (
            <img src={apiAsset(project.thumbnailUrl)} alt="" loading="lazy" className="h-full w-full object-cover" />
          )}
        </Link>
        <span className="pointer-events-none absolute left-2 top-2">
          <Badge tone={status.tone}>{status.label}</Badge>
        </span>
        {project.seconds > 0 && (
          <span className="tabular pointer-events-none absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-2xs font-medium text-white">
            {formatDuration(project.seconds)}
          </span>
        )}
        <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100">
          {project.videoUrl !== null && (
            <a
              href={apiAsset(project.videoUrl)}
              download
              aria-label={'Download ' + name}
              title="Download"
              className="flex h-7 w-7 items-center justify-center rounded-md bg-black/70 text-white hover:bg-black/85"
            >
              <Download aria-hidden="true" className="h-3.5 w-3.5" />
            </a>
          )}
          <button
            type="button"
            onClick={() => setConfirming(true)}
            aria-label={'Delete ' + name}
            title="Delete"
            className="flex h-7 w-7 items-center justify-center rounded-md bg-black/70 text-white hover:bg-bad"
          >
            <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="mt-2 min-w-0 px-0.5">
        <Link to={'/app/p/' + project.id} className="block truncate text-sm font-medium text-ink hover:underline">
          {name}
        </Link>
        <p className="mt-0.5 truncate text-xs text-ink-3">
          {languageName(catalogue, project.language)} ·{' '}
          <time dateTime={project.updatedAt} title={formatDateTime(project.updatedAt)}>
            {formatWhen(project.updatedAt)}
          </time>
          {project.hasSubtitles && ' · Captions'}
          {project.dubbedInto.length > 0 && ` · ${project.dubbedInto.length} dub${project.dubbedInto.length === 1 ? '' : 's'}`}
        </p>
        {shown.length > 0 && (
          <div className="mt-2 space-y-1.5">
            {shown.map((j) => (
              <JobLine key={j.id} job={j} />
            ))}
          </div>
        )}
        {confirming && (
          <div className="mt-2 rounded-md border border-line-strong bg-panel-2 p-2" role="group" aria-label="Confirm delete">
            <p className="text-xs text-ink">Delete this reel and its footage?</p>
            <div className="mt-2 flex gap-2">
              <Button size="xs" variant="danger" onClick={() => onDelete()}>
                Delete
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
                Keep
              </Button>
            </div>
          </div>
        )}
      </div>
    </li>
  );
}

/** Shaped like a real tile, so nothing moves when the reels arrive. */
export function ProjectCardSkeleton() {
  return (
    <li aria-hidden="true">
      <Skeleton className="aspect-[4/5] w-full rounded-lg" />
      <Skeleton className="mt-2 h-4 w-3/4" />
      <Skeleton className="mt-1.5 h-3 w-1/2" />
    </li>
  );
}
