import {
  FRAME_H,
  FRAME_W,
  ZOOM_SPAN,
  coverSrc,
  type FillLayer,
  type FrameSpec,
  type Layer,
  type Rect,
  type SourceSize,
  type TextLayer,
} from './compose.js';

/**
 * A FrameSpec, as ffmpeg filters.
 *
 * ── The rule this file exists to enforce ─────────────────────────────
 *
 * Every number ffmpeg is asked to work out for itself is a number the
 * browser's canvas cannot see. So this emits none of them. No
 * `force_original_aspect_ratio`, which hides a scale factor inside the
 * filter; no `y=h-th-N`, which hides the height of a text block; no
 * `box=1`, which sizes a rectangle from glyph metrics. Each becomes an
 * explicit integer that `compose.ts` computed and the canvas will read.
 *
 * The result is longer and less idiomatic than the filtergraph a person
 * would write by hand. That is the trade: an idiomatic filtergraph is one
 * where ffmpeg and the preview each do their own arithmetic, and the day
 * they disagree is the day the export no longer matches what was approved.
 *
 * ── Where parity is exact and where it is not ────────────────────────
 *
 * Exact: every crop, every scale, every overlay position, every box, and
 * the vertical position of every line of text. These are shared integers.
 *
 * Not exact, and stated rather than hidden:
 *
 *   - Horizontal text centring. ffmpeg centres by its own `text_w`, canvas
 *     by `textAlign`. Both centre about the same axis, so the residual is
 *     the font's own metrics -- same file, same shaping, sub-pixel.
 *   - The top edge of a glyph box. ffmpeg's `y` and canvas's
 *     `textBaseline='top'` both mean "top of the text", measured slightly
 *     differently from the font's ascent. A few pixels at most.
 *   - The photograph's zoom, which ffmpeg evaluates per frame. The
 *     expression below is the same formula `photoZoom` implements, written
 *     in ffmpeg's syntax, and the two are held together by a test that
 *     samples frames and compares -- not by sharing a number. One pixel of
 *     independent rounding is tolerated there.
 */

/** ffmpeg's `0xRRGGBB` is also how a Theme writes a colour. No conversion. */
const colour = (c: string, alpha: number): string =>
  alpha >= 1 ? c : `${c}@${alpha.toFixed(3)}`;

/**
 * Text, escaped for drawtext.
 *
 * drawtext reads `:` as its own option separator and `'` as a quote, so an
 * unescaped caption truncates the filtergraph instead of failing -- exit
 * code zero, nothing on stderr, and a reel missing its words. Backslash
 * first, or the escapes get escaped.
 */
export const escText = (s: string): string =>
  s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, '’')
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%');

/**
 * A font path, for drawtext.
 *
 * A Windows path carries drawtext's option separator in `C:`. Unescaped,
 * ffmpeg quietly ignores the font and falls back to its built-in monospace
 * face: exit code zero again, and the reel comes out set in Courier. Only
 * a screenshot ever shows it.
 */
export const escFontPath = (p: string): string =>
  p.replace(/\\/g, '/').replace(/:/g, '\\:');

/** An explicit crop, then an explicit scale. Never ffmpeg's own fitting. */
export function cropScale(src: Rect, dst: { w: number; h: number }): string[] {
  return [
    `crop=${src.w}:${src.h}:${src.x}:${src.y}`,
    `scale=${dst.w}:${dst.h}`,
    'setsar=1',
  ];
}

/**
 * The photograph's push, as a filter chain.
 *
 * ── Why it is shaped like this, and not the obvious way ──────────────
 *
 * The obvious way is one `crop` whose width and height are expressions in
 * `t`. It does not work, and it fails silently: **ffmpeg's crop filter
 * evaluates `w` and `h` once when the graph is configured**, and only `x`
 * and `y` per frame. So a time-varying crop size is frozen at its first
 * value while the offsets keep moving -- which renders a photograph
 * *panning sideways* at a fixed magnification, at exit code zero. It looks
 * deliberate. It was caught here only by measuring a known square in the
 * output and finding it never changed size.
 *
 * `scale`, unlike `crop`, has an `eval` option that re-evaluates per frame.
 * So the zoom lives there instead, and both crops have constant sizes:
 *
 *   1. crop the cover region -- constant, so crop's limitation is moot
 *   2. scale it up by the zoom, re-evaluated every frame
 *   3. crop the frame back out of the middle -- constant size, moving
 *      offsets, which is exactly what crop *can* do
 *
 * This is also the third distinct way this project has tried to render a
 * Ken Burns move: `-loop 1` with `zoompan d=1` renders a dead still
 * (zoompan's `zoom` is the previous frame's zoom within a d-sequence, so
 * d=1 resets it forever), one input frame with `d=frames` works but is
 * opaque, and this is the one that is both correct and legible.
 *
 * `min(max(...))` clamps exactly as the TypeScript does, which matters on
 * the last frame, where `t` can land a hair past the duration.
 */
export function photoZoomChain(
  source: SourceSize,
  seconds: number,
  index: number,
): string[] {
  const base = coverSrc(source, { w: FRAME_W, h: FRAME_H });
  const dur = Math.max(0.001, seconds);
  // Commas inside a filter option have to be escaped, or they read as the
  // start of the next filter in the chain.
  const p = `min(max(t/${dur.toFixed(6)}\\,0)\\,1)`;
  const z =
    index % 2 === 0 ? `(1+${ZOOM_SPAN}*${p})` : `(1+${ZOOM_SPAN}*(1-${p}))`;
  return [
    `crop=${base.w}:${base.h}:${base.x}:${base.y}`,
    // Even dimensions: an odd intermediate size in yuv420p makes the
    // scaler complain and can shift chroma by half a pixel.
    `scale=w='ceil(${FRAME_W}*${z}/2)*2':h='ceil(${FRAME_H}*${z}/2)*2':eval=frame`,
    `crop=${FRAME_W}:${FRAME_H}:x='(iw-${FRAME_W})/2':y='(ih-${FRAME_H})/2'`,
    'setsar=1',
  ];
}

/** A caption's band. An explicit rectangle, never one sized from glyphs. */
export function fillFilter(layer: FillLayer): string {
  const { rect } = layer;
  return (
    `drawbox=x=${rect.x}:y=${rect.y}:w=${rect.w}:h=${rect.h}:` +
    `color=${colour(layer.color, layer.alpha)}:t=fill`
  );
}

/** One line of text at an explicit top edge. */
export function textFilter(layer: TextLayer, fontFile: string | null): string {
  const parts = [
    fontFile ? `fontfile='${escFontPath(fontFile)}'` : 'font=sans',
    `text='${escText(layer.text)}'`,
    `fontcolor=${layer.color}`,
    `fontsize=${layer.size}`,
    // Centred about the same axis the canvas centres about.
    'x=(w-text_w)/2',
    `y=${layer.top}`,
  ];
  if (layer.outline) {
    // An outline per glyph, not a scrim behind the block. Stacked
    // translucent boxes compound at every overlap and show as stripes
    // across the picture; an outline is readable over anything.
    parts.push(
      `borderw=${layer.outline.width}`,
      `bordercolor=${colour(layer.outline.color, 0.92)}`,
      'shadowcolor=0x000000@0.55',
      'shadowx=2',
      'shadowy=3',
    );
  }
  return `drawtext=${parts.join(':')}`;
}

/**
 * The fill and text layers of a spec, in paint order.
 *
 * Media layers are not here: they decide the shape of the whole graph
 * (which inputs exist, what is overlaid on what), so the caller places
 * them and asks for the overlay chain separately.
 */
export function overlayFilters(
  layers: readonly Layer[],
  fontFile: string | null,
): string[] {
  const out: string[] = [];
  for (const l of layers) {
    if (l.kind === 'fill') out.push(fillFilter(l));
    else if (l.kind === 'text') out.push(textFilter(l, fontFile));
  }
  return out;
}

/** The media layer of a spec, when it has one. */
export function mediaLayer(spec: FrameSpec) {
  return spec.layers.find((l) => l.kind === 'media');
}
