import type { Shot } from './store.js';
import type { Theme } from '../domain/workspace.js';

/**
 * What is on the screen at a given instant, as numbers.
 *
 * ── Why this module exists ───────────────────────────────────────────
 *
 * A browser editor has two renderers: a canvas that draws the preview and
 * ffmpeg that writes the file. The failure that defines bad editors is the
 * two disagreeing -- a caption that sits lower in the export than in the
 * preview, a crop that shifts, a zoom that ends somewhere else. It is a
 * miserable bug to chase because both renderers are individually correct;
 * what is wrong is that each one did its own arithmetic.
 *
 * So neither does any. This module solves the geometry once and hands both
 * backends the same explicit rectangles. The ffmpeg filtergraph is built
 * from these numbers with no `force_original_aspect_ratio` and no
 * text-relative positioning, because every expression ffmpeg evaluates for
 * itself is a number the canvas cannot see.
 *
 * ── What that costs ──────────────────────────────────────────────────
 *
 * Two deliberate design changes fall out of it, both recorded here so that
 * nobody "fixes" them back:
 *
 *   1. A caption's backing box is a FULL-WIDTH band, not a box hugging the
 *      glyphs. A hugging box needs the text's measured width, which ffmpeg
 *      knows and canvas only knows after a measureText in the exact same
 *      font -- so it cannot be made to agree by construction. A band also
 *      looks better across two ragged lines.
 *   2. Multi-line captions are emitted as ONE TEXT LAYER PER LINE with an
 *      explicit top edge, rather than one drawtext containing newlines.
 *      ffmpeg's own multi-line height calculation is then never consulted.
 *
 * Everything here is pure. No fs, no ffmpeg, no canvas, no DOM -- which is
 * the point: the geometry of a video editor is testable in a terminal.
 */

/** The output frame. A reel is one shape, so these are not parameters. */
export const FRAME_W = 1080;
export const FRAME_H = 1920;
export const FRAME_FPS = 30;

/** Pixels. Top-left origin, y down -- canvas's convention and ffmpeg's. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** `0xRRGGBB`, as a Theme states colours. Backends format it themselves. */
export type Color = string;

export interface MediaLayer {
  readonly kind: 'media';
  /** Relative to the workspace's assets directory. */
  readonly path: string;
  /** Which part of the source to take. In SOURCE pixels. */
  readonly src: Rect;
  /** Where it lands in the frame. In FRAME pixels. */
  readonly dst: Rect;
  /**
   * A colour grade, as a CSS filter list ("brightness(1.1) contrast(1.2)").
   * Canvas-only: the browser preview and export apply it; the server's
   * ffmpeg render does not yet, and ignores the field.
   */
  readonly filter?: string;
  /** Warmth or coolness, laid over the picture in soft-light. Canvas-only. */
  readonly tint?: { readonly color: Color; readonly alpha: number };
}

export interface FillLayer {
  readonly kind: 'fill';
  readonly rect: Rect;
  readonly color: Color;
  /** 0..1. A band behind a caption is translucent; the ground is not. */
  readonly alpha: number;
}

export interface TextLayer {
  readonly kind: 'text';
  readonly text: string;
  /** Horizontal centre of the line. Both backends centre about this. */
  readonly centerX: number;
  /** TOP edge of the line, not the baseline. Canvas sets textBaseline. */
  readonly top: number;
  readonly size: number;
  readonly color: Color;
  /**
   * An outline, drawn per glyph, in place of a band.
   *
   * Over a photograph a band reads as a sticker, and stacked translucent
   * bands compound at their overlaps into visible stripes -- which is how
   * this repo learned to stop using them over footage.
   */
  readonly outline: { readonly width: number; readonly color: Color } | null;
}

export type Layer = MediaLayer | FillLayer | TextLayer;

export interface FrameSpec {
  readonly width: number;
  readonly height: number;
  readonly background: Color;
  /** Painted in order. First is furthest back. */
  readonly layers: readonly Layer[];
}

/** Intrinsic size of a source file. The caller measures it once. */
export interface SourceSize {
  readonly w: number;
  readonly h: number;
}

// ---------------------------------------------------------------------------
// The two fitting rules. Everything visual in this product is one of them.

/**
 * Fill the destination and crop the overflow, centred.
 *
 * Returns the SOURCE rectangle to take. Used for footage and photographs,
 * where the subject is a face near the middle and empty margins would read
 * as a document scan rather than as a reel.
 */
export function coverSrc(src: SourceSize, dst: { w: number; h: number }): Rect {
  const scale = Math.max(dst.w / src.w, dst.h / src.h);
  // Width and height of the source region that maps onto the destination.
  const w = Math.min(src.w, dst.w / scale);
  const h = Math.min(src.h, dst.h / scale);
  return {
    x: Math.round((src.w - w) / 2),
    y: Math.round((src.h - h) / 2),
    w: Math.round(w),
    h: Math.round(h),
  };
}

/**
 * Fit the whole source inside the destination, centred, and letterbox.
 *
 * Returns the DESTINATION rectangle. Used for product screenshots, where
 * cropping removes the thing the shot exists to point at.
 */
export function containDst(
  src: SourceSize,
  box: { x: number; y: number; w: number; h: number },
): Rect {
  const scale = Math.min(box.w / src.w, box.h / src.h);
  const w = Math.round(src.w * scale);
  const h = Math.round(src.h * scale);
  return {
    x: Math.round(box.x + (box.w - w) / 2),
    y: Math.round(box.y + (box.h - h) / 2),
    w,
    h,
  };
}

// ---------------------------------------------------------------------------
// Captions.

/**
 * A caption, broken to fit the frame.
 *
 * Neither backend wraps: ffmpeg's drawtext draws a long line straight past
 * both edges and reports nothing, and canvas does the same. So wrapping is
 * decided here, once, and both are handed finished lines.
 */
export function wrapLines(text: string, perLine: number): string[] {
  return text
    .split('\n')
    .flatMap((para) => {
      const words = para.split(/\s+/).filter(Boolean);
      const out: string[] = [];
      let cur = '';
      for (const word of words) {
        if (cur && cur.length + 1 + word.length > perLine) {
          out.push(cur);
          cur = word;
        } else {
          cur = cur ? cur + ' ' + word : word;
        }
      }
      if (cur) out.push(cur);
      return out;
    })
    .filter((l) => l.length > 0);
}

/** Gap between a caption's lines, as a fraction of its size. */
const LINE_GAP = 0.19;
/** Breathing room inside a caption's band. */
const BAND_PAD = 26;

/**
 * The caption block: an optional band, then one layer per line.
 *
 * Laid out upward from a fixed distance above the bottom edge, so a
 * two-line caption grows into the frame rather than off the bottom of it.
 * Instagram's own furniture sits along the bottom and across the top, which
 * is what `captionFromBottom` keeps clear of.
 */
export function captionLayers(
  caption: string,
  theme: Theme,
  banded: boolean,
): Layer[] {
  const lines = wrapLines(caption, theme.wrapAt);
  if (lines.length === 0) return [];

  const size = theme.captionSize;
  const step = Math.round(size * (1 + LINE_GAP));
  const blockH = size + step * (lines.length - 1);
  const bottom = FRAME_H - Math.round(FRAME_H * theme.captionFromBottom);
  const top = bottom - blockH;

  const layers: Layer[] = [];
  if (banded) {
    layers.push({
      kind: 'fill',
      rect: { x: 0, y: top - BAND_PAD, w: FRAME_W, h: blockH + BAND_PAD * 2 },
      color: theme.ground,
      alpha: 0.82,
    });
  }
  lines.forEach((text, i) => {
    layers.push({
      kind: 'text',
      text,
      centerX: Math.round(FRAME_W / 2),
      top: top + step * i,
      size,
      color: theme.ink,
      outline: banded ? null : { width: 5, color: theme.ground },
    });
  });
  return layers;
}

// ---------------------------------------------------------------------------
// The photograph's move.

/** Zoom travelled across a photo shot. A still frame reads as a mistake. */
export const ZOOM_SPAN = 0.18;

/**
 * How far into a photograph the camera has pushed, at a point in a shot.
 *
 * `progress` is 0 at the shot's first frame and 1 at its last. Direction
 * alternates with the shot's index so that consecutive photographs do not
 * both drift the same way, which reads as a slideshow transition.
 *
 * This is the one piece of geometry the two backends implement separately,
 * because ffmpeg evaluates its own expression per frame and there is no
 * number to share. It is therefore held to agreement by measurement rather
 * than by construction: `render-parity.test.mts` renders a square of known
 * size and reads its width back out of the encoded frames, which is the
 * only check that does not re-derive the formula it is testing.
 *
 * Writing that test found that the ffmpeg side was panning sideways rather
 * than zooming at all, because `crop` fixes its width at configuration
 * time. The comment claiming a test existed had been there for a while;
 * the test had not. Keep them together.
 */
export function photoZoom(progress: number, index: number): number {
  const p = Math.max(0, Math.min(1, progress));
  return index % 2 === 0 ? 1 + ZOOM_SPAN * p : 1 + ZOOM_SPAN * (1 - p);
}

// ---------------------------------------------------------------------------
// The whole frame.

export interface ComposeInput {
  readonly shot: Shot;
  /** Its position in the reel. Only the photo drift reads this. */
  readonly index: number;
  /** Seconds into this shot, not into the reel. */
  readonly t: number;
  /** How long the shot runs. Needed to turn `t` into progress. */
  readonly seconds: number;
  readonly theme: Theme;
  /** Intrinsic size of the shot's source, when it has one. */
  readonly source: SourceSize | null;
  /**
   * The caption to draw instead of the shot's own, for this instant.
   *
   * Auto-subtitles change several times within one shot, and a `Shot`
   * carries a single caption -- so the time-varying case is passed in
   * rather than built into the shot. `null` or absent means "use the
   * shot's caption"; a string, **including an empty one**, overrides it.
   * The empty case matters: between two cues there is genuinely no caption,
   * and falling back to the shot's own text there would make the scripted
   * line flash up in every gap between spoken words.
   *
   * The caller decides which cue is active (see `subtitles.ts`), so this
   * module stays pure and the timing logic stays testable on its own.
   */
  readonly captionOverride?: string | null;
}

/**
 * One instant of one shot, fully specified.
 *
 * A missing `source` size is not an error: it means the caller could not
 * measure the file, and the frame degrades to its caption over the ground
 * rather than throwing in the middle of a scrub.
 */
export function composeFrame(input: ComposeInput): FrameSpec {
  const { shot, index, t, seconds, theme, source } = input;
  const caption =
    input.captionOverride === undefined || input.captionOverride === null
      ? shot.caption
      : input.captionOverride;
  const layers: Layer[] = [];
  const full = { w: FRAME_W, h: FRAME_H };
  const frame = (ls: Layer[]): FrameSpec => ({
    width: FRAME_W,
    height: FRAME_H,
    background: theme.ground,
    layers: ls,
  });

  if (shot.source.kind === 'clip' && source) {
    layers.push({
      kind: 'media',
      path: shot.source.path,
      src: coverSrc(source, full),
      dst: { x: 0, y: 0, w: FRAME_W, h: FRAME_H },
    });
    layers.push(...captionLayers(caption, theme, false));
    return frame(layers);
  }

  if (shot.source.kind === 'photo' && source) {
    const base = coverSrc(source, full);
    const z = photoZoom(seconds > 0 ? t / seconds : 0, index);
    // Zooming in means taking LESS of the source, about the same centre.
    const w = Math.round(base.w / z);
    const h = Math.round(base.h / z);
    layers.push({
      kind: 'media',
      path: shot.source.path,
      src: {
        x: base.x + Math.round((base.w - w) / 2),
        y: base.y + Math.round((base.h - h) / 2),
        w,
        h,
      },
      dst: { x: 0, y: 0, w: FRAME_W, h: FRAME_H },
    });
    layers.push(...captionLayers(caption, theme, false));
    return frame(layers);
  }

  if (shot.source.kind === 'asset' && source) {
    // Fitted inside, lifted above centre so the caption below it is not
    // crowded. The box is the same on every asset shot, so a reel of
    // screenshots does not jitter as their aspect ratios change.
    const box = {
      x: Math.round(FRAME_W * 0.04),
      y: Math.round(FRAME_H * 0.15),
      w: Math.round(FRAME_W * 0.92),
      h: Math.round(FRAME_H * 0.58),
    };
    layers.push({
      kind: 'media',
      path: shot.source.path,
      src: { x: 0, y: 0, w: source.w, h: source.h },
      dst: containDst(source, box),
    });
    layers.push(...captionLayers(caption, theme, true));
    return frame(layers);
  }

  // A card, and the fallback for an unmeasurable source.
  const label = shot.source.kind === 'solid' ? shot.source.label : '';
  if (label) {
    layers.push({
      kind: 'text',
      text: label,
      centerX: Math.round(FRAME_W / 2),
      top: Math.round(FRAME_H * 0.36),
      size: theme.labelSize,
      color: theme.mutedInk,
      outline: null,
    });
  }
  layers.push(...captionLayers(caption, theme, true));
  return frame(layers);
}
