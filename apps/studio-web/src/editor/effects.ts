import { FRAME_H, FRAME_W, type FrameSpec, type Layer } from '../../../studio/src/lib/compose.js';
import type { Grade } from '../../../studio/src/lib/timeline.js';
import type { Clip } from '../../../studio/src/lib/timeline.js';

/**
 * A clip's look and motion, applied to its composed frame.
 *
 * Pure functions over a `FrameSpec`, used by the preview and the export
 * alike, so a graded, pushed, faded clip looks the same in both. The
 * compositor that builds the spec is not touched: effects are a pass over
 * its output, which keeps them out of the layout code that captions and
 * the server render depend on.
 */

export const NEUTRAL: Grade = { exposure: 1, contrast: 1, saturation: 1, warmth: 0 };

export const LOOKS: readonly { id: string; label: string; grade: Grade }[] = [
  { id: 'natural', label: 'Natural', grade: NEUTRAL },
  { id: 'warm', label: 'Warm', grade: { exposure: 1.04, contrast: 1.06, saturation: 1.1, warmth: 0.5 } },
  { id: 'cool', label: 'Cool', grade: { exposure: 1, contrast: 1.08, saturation: 0.95, warmth: -0.5 } },
  { id: 'punchy', label: 'Punchy', grade: { exposure: 1.02, contrast: 1.25, saturation: 1.3, warmth: 0.1 } },
  { id: 'mono', label: 'B&W', grade: { exposure: 1.05, contrast: 1.2, saturation: 0, warmth: 0 } },
];

const WARM = '0xFF9A3C';
const COOL = '0x3C8CFF';

const isNeutral = (g: Grade) => g.exposure === 1 && g.contrast === 1 && g.saturation === 1 && g.warmth === 0;

/** Smooth start and end, so a push does not lurch in or stop dead. */
const ease = (t: number) => t * t * (3 - 2 * t);

/** Grade and push on one clip's own layers. */
export function look(spec: FrameSpec, clip: Clip, local: number): FrameSpec {
  const grade = clip.grade && !isNeutral(clip.grade) ? clip.grade : null;
  const zoom = clip.zoom && (clip.zoom.from !== 1 || clip.zoom.to !== 1) ? clip.zoom : null;
  if (!grade && !zoom) return spec;

  const filter = grade
    ? `brightness(${grade.exposure}) contrast(${grade.contrast}) saturate(${grade.saturation})`
    : undefined;
  const tint =
    grade && grade.warmth !== 0
      ? { color: grade.warmth > 0 ? WARM : COOL, alpha: Math.min(0.6, Math.abs(grade.warmth) * 0.45) }
      : undefined;
  const scale = zoom ? zoom.from + (zoom.to - zoom.from) * ease(Math.max(0, Math.min(1, local / Math.max(clip.duration, 0.001)))) : 1;
  const cx = FRAME_W / 2;
  const cy = FRAME_H / 2;

  const layers: Layer[] = spec.layers.map((l) => {
    if (l.kind !== 'media') return l;
    const dst =
      scale === 1
        ? l.dst
        : { x: cx + (l.dst.x - cx) * scale, y: cy + (l.dst.y - cy) * scale, w: l.dst.w * scale, h: l.dst.h * scale };
    return { ...l, dst, ...(filter ? { filter } : {}), ...(tint ? { tint } : {}) };
  });
  return { ...spec, layers };
}

/** Fade from and to black at the clip's edges, over everything drawn. */
export function fade(spec: FrameSpec, clip: Clip, local: number): FrameSpec {
  const fin = clip.fadeIn && local < clip.fadeIn ? 1 - local / clip.fadeIn : 0;
  const left = clip.duration - local;
  const fout = clip.fadeOut && left < clip.fadeOut ? 1 - left / clip.fadeOut : 0;
  const alpha = Math.max(0, Math.min(1, Math.max(fin, fout)));
  if (alpha === 0) return spec;
  return {
    ...spec,
    layers: [...spec.layers, { kind: 'fill', rect: { x: 0, y: 0, w: FRAME_W, h: FRAME_H }, color: '0x000000', alpha }],
  };
}

/** Where in its source a clip is at a local time, at its speed. */
export const sourceTime = (clip: Clip, local: number): number => clip.sourceIn + local * (clip.speed ?? 1);

// ── Caption styles ─────────────────────────────────────────────────────

export interface CaptionStyle {
  readonly size: 'S' | 'M' | 'L';
  readonly position: 'low' | 'middle';
  readonly colour: 'white' | 'yellow';
}

export const DEFAULT_CAPTIONS: CaptionStyle = { size: 'M', position: 'low', colour: 'white' };

/** The reel theme with a caption style laid over it. */
export function captionTheme<T extends { captionSize: number; captionFromBottom: number; ink: string }>(theme: T, style: CaptionStyle): T {
  return {
    ...theme,
    captionSize: style.size === 'S' ? 50 : style.size === 'L' ? 80 : theme.captionSize,
    captionFromBottom: style.position === 'middle' ? 0.42 : theme.captionFromBottom,
    ink: style.colour === 'yellow' ? '0xFFD233' : theme.ink,
  };
}
