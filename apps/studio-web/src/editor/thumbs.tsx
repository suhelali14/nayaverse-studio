import { Film, ImageIcon, Type } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { composeFrame } from '../../../studio/src/lib/compose.js';
import type { Clip } from '../../../studio/src/lib/timeline.js';
import type { Theme } from '../../../studio/src/domain/workspace.js';
import { paintFrame, type Painter2D } from '../../../studio/src/web/paint.js';
import { cx } from '../components/ui';
import themeDefaults from './theme-defaults.json';
import { CAPTION_FACE, type Editor } from './useEditor';

/**
 * Thumbnails, drawn from the bitmaps the editor already decoded.
 *
 * Every thumbnail is a fixed 9:16 box at one size, whatever the source's
 * shape, so rows and tiles compare at a glance instead of each sizing
 * itself to its own content.
 */

/** A still drawn into a fixed box, cropped to cover it. */
export function StillThumb({ bitmap, width = 72, height = 128, className }: {
  bitmap: ImageBitmap;
  width?: number;
  height?: number;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    const scale = Math.max(width / bitmap.width, height / bitmap.height);
    const w = bitmap.width * scale;
    const h = bitmap.height * scale;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(bitmap, (width - w) / 2, (height - h) / 2, w, h);
  }, [bitmap, width, height]);
  return <canvas ref={ref} width={width} height={height} className={cx('h-full w-full', className)} aria-hidden="true" />;
}

const KIND_BG: Record<Clip['source']['kind'], string> = {
  clip: 'bg-kind-clip',
  photo: 'bg-kind-photo',
  asset: 'bg-kind-asset',
  solid: 'bg-kind-solid',
};

export function SourceIcon({ kind, className }: { kind: Clip['source']['kind']; className?: string }) {
  const Icon = kind === 'clip' ? Film : kind === 'solid' ? Type : ImageIcon;
  return <Icon aria-hidden="true" className={cx('h-4 w-4', className)} />;
}

/**
 * A text card, drawn by the same compositor as the reel, so the thumbnail
 * is the card's real frame -- its ground, its line, its type -- rather than
 * a glyph standing in for it.
 */
function CardThumb({ clip }: { clip: Clip }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const small = ref.current?.getContext('2d');
    if (!small) return;
    const full = document.createElement('canvas');
    full.width = 1080;
    full.height = 1920;
    const ctx = full.getContext('2d');
    if (!ctx) return;
    paintFrame(
      ctx as unknown as Painter2D,
      composeFrame({
        shot: { seconds: clip.duration, caption: clip.caption, source: clip.source },
        index: 0,
        t: clip.duration / 2,
        seconds: clip.duration,
        theme: themeDefaults as Theme,
        source: null,
      }),
      { fontFamily: CAPTION_FACE, sources: new Map() },
    );
    small.clearRect(0, 0, 72, 128);
    small.drawImage(full, 0, 0, 72, 128);
  }, [clip.caption, clip.duration, clip.source]);
  return <canvas ref={ref} width={72} height={128} className="h-full w-full" aria-hidden="true" />;
}

/** The thumbnail for a clip on the timeline or in the scene list. */
export function ClipThumb({ clip, ed, className }: { clip: Clip; ed: Editor; className?: string }) {
  const box = cx('flex shrink-0 items-center justify-center overflow-hidden rounded', className);
  if (clip.source.kind === 'solid') {
    return (
      <span className={cx(box, 'bg-kind-solid')}>
        <CardThumb clip={clip} />
      </span>
    );
  }
  if (clip.source.kind === 'photo' || clip.source.kind === 'asset') {
    const still = ed.stills.current.get(clip.source.path);
    if (still) {
      return (
        <span className={cx(box, 'bg-panel-3')}>
          <StillThumb bitmap={still.bitmap} />
        </span>
      );
    }
  }
  return (
    <span className={cx(box, KIND_BG[clip.source.kind], 'text-white/85')}>
      <SourceIcon kind={clip.source.kind} />
    </span>
  );
}

export { KIND_BG };
