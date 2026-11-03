import type { Clip } from '../../../studio/src/lib/timeline.js';
import { Badge, cx } from '../components/ui';
import { ClipThumb } from './thumbs';
import { formatClock } from './time';
import type { Editor, ShotInfo } from './useEditor';

/**
 * Every scene of the reel, in order: a second view of the timeline.
 *
 * The row under the playhead is marked as playing and follows playback, so
 * pressing play walks the mark down the list. Rows the Script panel just
 * placed carry a New badge until they have been played or selected, so a
 * re-cut never silently changes a reel under its creator.
 */

function sourceLine(info: ShotInfo | undefined, clip: Clip): string {
  const file = clip.source.kind === 'solid' ? null : clip.source.path;
  if (!info) return file ?? 'Text card';
  if (info.match.kind === 'keyword') return `${file} · “${info.match.on.join('”, “')}”`;
  if (info.match.kind === 'fill') return `${file} · fill`;
  return 'Text card';
}

export function Scenes({ ed, unseen }: { ed: Editor; unseen: ReadonlySet<string> }) {
  const nowId =
    ed.clips.find((c) => ed.playhead >= c.start && ed.playhead < c.start + c.duration)?.id ??
    (ed.clips.length > 0 && ed.playhead >= ed.total ? ed.clips[ed.clips.length - 1]!.id : null);

  if (ed.clips.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <p className="text-sm font-medium text-ink">No scenes yet</p>
        <p className="mx-auto mt-1 max-w-[30ch] text-xs leading-relaxed text-ink-3">
          Make the reel from a script, or add media and text cards to the timeline.
        </p>
      </div>
    );
  }

  return (
    <ol aria-label="Scenes" className="space-y-1 p-2">
      {ed.clips.map((clip) => {
        const info = ed.shotInfo(clip.id);
        const now = clip.id === nowId;
        const selected = clip.id === ed.selected;
        return (
          <li key={clip.id}>
            <button
              type="button"
              aria-current={now ? 'true' : undefined}
              aria-pressed={selected}
              onClick={() => {
                ed.actions.select(clip.id);
                ed.actions.seek(clip.start);
              }}
              className={cx(
                'grid w-full grid-cols-[36px_minmax(0,1fr)] gap-3 rounded-md p-2 text-left transition-colors duration-150',
                selected ? 'bg-panel-3 ring-1 ring-inset ring-line-strong' : 'hover:bg-panel-2',
              )}
            >
              <ClipThumb clip={clip} ed={ed} className="h-16 w-9" />
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-xs">
                  <span className="truncate font-semibold text-ink">
                    {info?.label ?? (clip.source.kind === 'solid' ? 'Text card' : 'Clip')}
                  </span>
                  {now && (
                    <span className="flex items-center gap-1 text-accent">
                      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
                      <span className="text-2xs font-semibold">Playing</span>
                    </span>
                  )}
                  {unseen.has(clip.id) && !now && <Badge>New</Badge>}
                  <time className="ml-auto shrink-0 text-ink-3">{formatClock(clip.start)}</time>
                </span>
                <span className="mt-1 line-clamp-2 text-xs leading-snug text-ink-2">
                  {clip.caption.trim() || <span className="text-ink-3">No caption</span>}
                </span>
                <span className="mt-1 block truncate text-2xs text-ink-3">
                  {sourceLine(info, clip)} · {clip.duration.toFixed(1)}s
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
