import type { FrameSpec, Layer } from '../lib/compose.js';

/**
 * A FrameSpec, painted.
 *
 * The browser half of the parity contract. `filtergraph.ts` translates the
 * same spec into ffmpeg filters; this translates it into draw calls. Neither
 * computes anything -- that is the whole arrangement, and it is why a
 * caption cannot end up in two different places.
 *
 * ── Why the context is structurally typed ────────────────────────────
 *
 * The parameter is not `CanvasRenderingContext2D`. It is the subset of it
 * this module actually uses, declared here, which a real canvas satisfies
 * and so does a recording fake. That makes the browser renderer testable
 * in a terminal: the test paints a frame into a fake and asserts the draw
 * calls carry the solver's numbers.
 *
 * Without that, the canvas backend would be the one half of the parity
 * claim nobody could check until a human looked at a screen -- which is
 * exactly how the two renderers drift apart in the first place.
 */

/** What painting a frame needs. A real 2D context is a superset. */
export interface Painter2D {
  fillStyle: string;
  strokeStyle: string;
  globalAlpha: number;
  /** Optional: only grading uses them, and a test double may omit them. */
  filter?: string;
  globalCompositeOperation?: string;
  font: string;
  textAlign: string;
  textBaseline: string;
  lineWidth: number;
  lineJoin: string;
  shadowColor: string;
  shadowOffsetX: number;
  shadowOffsetY: number;
  save(): void;
  restore(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  drawImage(
    image: unknown,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
}

/**
 * A Theme writes colours as ffmpeg does, `0xRRGGBB`. CSS wants `#RRGGBB`.
 *
 * One conversion, in one place. A second copy of this is how a preview ends
 * up a different shade from its export.
 */
export const cssColour = (c: string, alpha = 1): string => {
  const hex = c.startsWith('0x') ? c.slice(2) : c.replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    // A named colour from a hand-edited theme. Passed through rather than
    // rejected mid-scrub; the schema is where a bad theme should fail.
    return alpha >= 1 ? c : c;
  }
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return alpha >= 1 ? `#${hex.toLowerCase()}` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/**
 * The font, as CSS.
 *
 * Bold, because a reel's captions are read at arm's length on a phone in
 * daylight. The family has to be the same file ffmpeg is given, or the two
 * renderers wrap identically and still look different -- which is why the
 * caller passes it rather than this module choosing.
 */
export const cssFont = (size: number, family: string): string =>
  `700 ${size}px ${family}`;

/** Images the painter can draw, keyed by the layer's path. */
export type Sources = ReadonlyMap<string, unknown>;

export interface PaintOptions {
  /** The face to set text in. Must be the face the export uses. */
  readonly fontFamily: string;
  /**
   * Decoded media, by path. A missing entry is skipped rather than drawn
   * as a hole: during a scrub the frame for a shot may not have arrived.
   */
  readonly sources: Sources;
}

/**
 * Paint one layer.
 *
 * Exported so a test can assert a single layer's draw calls without
 * reasoning about the rest of the frame.
 */
export function paintLayer(ctx: Painter2D, layer: Layer, opts: PaintOptions): void {
  if (layer.kind === 'media') {
    const image = opts.sources.get(layer.path);
    if (!image) return;
    const graded = layer.filter !== undefined || layer.tint !== undefined;
    if (graded) ctx.save();
    if (layer.filter) ctx.filter = layer.filter;
    ctx.drawImage(
      image,
      layer.src.x,
      layer.src.y,
      layer.src.w,
      layer.src.h,
      layer.dst.x,
      layer.dst.y,
      layer.dst.w,
      layer.dst.h,
    );
    if (layer.tint) {
      ctx.filter = 'none';
      ctx.globalCompositeOperation = 'soft-light';
      ctx.globalAlpha = layer.tint.alpha;
      ctx.fillStyle = cssColour(layer.tint.color);
      ctx.fillRect(layer.dst.x, layer.dst.y, layer.dst.w, layer.dst.h);
    }
    if (graded) ctx.restore();
    return;
  }

  if (layer.kind === 'fill') {
    ctx.save();
    ctx.fillStyle = cssColour(layer.color, layer.alpha);
    ctx.fillRect(layer.rect.x, layer.rect.y, layer.rect.w, layer.rect.h);
    ctx.restore();
    return;
  }

  ctx.save();
  ctx.font = cssFont(layer.size, opts.fontFamily);
  // Centred about the layer's own axis, and measured from the TOP of the
  // glyph box -- which is what ffmpeg's `y=` means too. Using the default
  // alphabetic baseline here would put every caption roughly one cap
  // height lower than the export.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  if (layer.outline) {
    // Drawn before the fill so the stroke sits behind the glyph rather
    // than eating into it, and round-joined so a thick outline does not
    // spike at sharp corners.
    ctx.lineJoin = 'round';
    ctx.lineWidth = layer.outline.width * 2;
    ctx.strokeStyle = cssColour(layer.outline.color, 0.92);
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 3;
    ctx.strokeText(layer.text, layer.centerX, layer.top);
    ctx.shadowColor = 'transparent';
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }
  ctx.fillStyle = cssColour(layer.color);
  ctx.fillText(layer.text, layer.centerX, layer.top);
  ctx.restore();
}

/**
 * Paint a whole frame.
 *
 * The ground is filled first rather than cleared, so a shot that does not
 * cover the frame letterboxes onto the house colour exactly as the export
 * does -- a transparent canvas would composite onto whatever the page
 * happens to be, and look right until the page changed.
 */
export function paintFrame(ctx: Painter2D, spec: FrameSpec, opts: PaintOptions): void {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = cssColour(spec.background);
  ctx.fillRect(0, 0, spec.width, spec.height);
  ctx.restore();
  for (const layer of spec.layers) paintLayer(ctx, layer, opts);
}
