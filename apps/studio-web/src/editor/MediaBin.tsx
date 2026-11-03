import { Layers, Music, Plus, Type, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useContextMenu } from '../components/ContextMenu';
import { Button, cx } from '../components/ui';
import { mediaMenu } from './menus';
import { useMediaDrag } from './useMediaDrag';
import { SourceIcon, StillThumb } from './thumbs';
import type { Editor, MediaItem } from './useEditor';

/**
 * The media bin: everything imported, whether or not it is on the timeline.
 *
 * Importing puts media here only. The Script panel chooses from the bin by
 * file name, so a creator can drop in twenty clips and let it decide which
 * goes under which line. By hand, a picture or a clip goes onto the main
 * track or cuts in over it at the playhead; a sound goes onto the music
 * track.
 */

/** A waveform drawn from decoded peaks, in the current text colour. */
export function Waveform({ peaks, from = 0, to, className }: { peaks: Float32Array; from?: number; to?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const { width, height } = canvas;
    const start = Math.floor(from * 50);
    const end = Math.min(peaks.length, Math.ceil((to ?? peaks.length / 50) * 50));
    const span = Math.max(1, end - start);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = getComputedStyle(canvas).color;
    for (let x = 0; x < width; x += 2) {
      const v = peaks[start + Math.floor((x / width) * span)] ?? 0;
      const h = Math.max(1, v * height);
      ctx.fillRect(x, (height - h) / 2, 1.5, h);
    }
  }, [peaks, from, to]);
  return <canvas ref={ref} width={240} height={40} className={cx('h-full w-full', className)} aria-hidden="true" />;
}

function Tile({ item, ed, onGrab }: { item: MediaItem; ed: Editor; onGrab: (item: MediaItem, e: React.PointerEvent) => void }) {
  const still = item.kind === 'photo' ? ed.stills.current.get(item.name) : undefined;
  const sound = item.kind === 'audio' ? ed.sounds.current.get(item.name) : undefined;
  const openMenu = useContextMenu();
  const edRef = useRef(ed);
  edRef.current = ed;
  return (
    <li className="group relative" onContextMenu={(e) => openMenu(e, mediaMenu(() => edRef.current, item), item.name)}>
      {/* The picture is the handle: drag it onto a track. */}
      <div
        onPointerDown={(e) => onGrab(item, e)}
        className="aspect-[9/16] cursor-grab select-none overflow-hidden rounded-md bg-panel-3 [-webkit-touch-callout:none] active:cursor-grabbing"
      >
        {still ? (
          <StillThumb bitmap={still.bitmap} width={90} height={160} />
        ) : item.kind === 'audio' ? (
          <span className="flex h-full w-full flex-col items-center justify-center gap-2 bg-panel-3 px-1.5 text-cue">
            <Music aria-hidden="true" className="h-4 w-4 text-ink-3" />
            {sound && <Waveform peaks={sound.peaks} className="h-8" />}
          </span>
        ) : (
          <span className="flex h-full w-full items-center justify-center bg-kind-clip text-white/85">
            <SourceIcon kind="clip" />
          </span>
        )}
      </div>
      {item.seconds !== null && (
        <span className="tabular absolute right-1 top-1 rounded bg-black/70 px-1 text-2xs text-white">{item.seconds.toFixed(1)}s</span>
      )}
      <div className="absolute inset-x-1 bottom-6 flex justify-end gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100">
        {item.kind === 'audio' ? (
          <button
            type="button"
            onClick={() => ed.actions.placeMusic(item.name)}
            aria-label={`Add ${item.name} to the music track`}
            title="Add to the music track"
            className="flex h-6 w-6 items-center justify-center rounded bg-black/70 text-white hover:bg-accent"
          >
            <Plus aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => ed.actions.placeOverlay(item.name)}
              aria-label={`Cut ${item.name} in over the main track at the playhead`}
              title="Overlay at playhead (B-roll)"
              className="flex h-6 w-6 items-center justify-center rounded bg-black/70 text-white hover:bg-accent"
            >
              <Layers aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => ed.actions.place(item.name)}
              aria-label={`Add ${item.name} to the timeline`}
              title="Add to the main track"
              className="flex h-6 w-6 items-center justify-center rounded bg-black/70 text-white hover:bg-accent"
            >
              <Plus aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>
      <p className="mt-1 truncate text-2xs text-ink-2" title={item.name}>
        {item.name}
      </p>
    </li>
  );
}

export function MediaBin({ ed }: { ed: Editor }) {
  const pick = useRef<HTMLInputElement | null>(null);
  const [over, setOver] = useState(false);
  const grab = useMediaDrag(ed);

  const take = (list: FileList | null) => {
    const files = [...(list ?? [])].filter(
      (f) => f.type === '' || f.type.startsWith('video/') || f.type.startsWith('image/') || f.type.startsWith('audio/'),
    );
    if (files.length) void ed.actions.load(files, false);
  };

  const visual = ed.library.filter((x) => x.kind !== 'audio');
  const audio = ed.library.filter((x) => x.kind === 'audio');

  return (
    <div
      className={cx('flex min-h-0 flex-col p-3 transition-colors', over && 'bg-accent-soft/40')}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        const to = e.relatedTarget;
        if (!(to instanceof Node) || !e.currentTarget.contains(to)) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        take(e.dataTransfer.files);
      }}
    >
      <input
        ref={pick}
        type="file"
        accept="video/*,image/*,audio/*"
        multiple
        hidden
        onChange={(e) => {
          take(e.target.files);
          e.target.value = '';
        }}
      />
      <div className="grid grid-cols-2 gap-2">
        <Button size="sm" onClick={() => pick.current?.click()}>
          <Upload aria-hidden="true" className="h-4 w-4" />
          Import
        </Button>
        <Button size="sm" onClick={ed.actions.addCard}>
          <Type aria-hidden="true" className="h-4 w-4" />
          Text card
        </Button>
      </div>

      {ed.library.length === 0 ? (
        <button
          type="button"
          onClick={() => pick.current?.click()}
          className="mt-3 flex flex-col items-center justify-center rounded-lg border border-dashed border-line-strong px-4 py-10 text-center hover:border-ink-3"
        >
          <Upload aria-hidden="true" className="h-5 w-5 text-ink-3" />
          <span className="mt-2 text-sm font-medium text-ink">Drop videos, photos or music</span>
          <span className="mt-1 text-xs text-ink-3">Name files by what they show, like desk.mp4</span>
        </button>
      ) : (
        <>
          {visual.length > 0 && (
            <ul aria-label="Pictures and video" className="mt-3 grid grid-cols-3 gap-2">
              {visual.map((item) => (
                <Tile key={item.name} item={item} ed={ed} onGrab={grab.begin} />
              ))}
            </ul>
          )}
          {audio.length > 0 && (
            <>
              <h3 className="mb-2 mt-4 text-2xs font-semibold text-ink-3">Music and sound</h3>
              <ul aria-label="Music and sound" className="grid grid-cols-3 gap-2">
                {audio.map((item) => (
                  <Tile key={item.name} item={item} ed={ed} onGrab={grab.begin} />
                ))}
              </ul>
            </>
          )}
          <p className="mt-4 text-2xs leading-relaxed text-ink-3">
            + adds to the main track · the layers icon cuts in over it at the playhead
          </p>
        </>
      )}
      {grab.ghost}
    </div>
  );
}
