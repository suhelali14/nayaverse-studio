/**
 * Do the two renderers agree, number for number?
 *
 * `render-parity.test.mts` proves ffmpeg obeys the solver, by reading
 * pixels out of a real mp4. This proves the *canvas* obeys the same solver,
 * and then compares the two backends against each other directly: the
 * geometry is parsed back out of the ffmpeg filter string and out of the
 * recorded canvas draw calls, and the two sets of numbers must be equal.
 *
 * That comparison is the actual product claim. Everything else in the
 * editor is ordinary software; this is the part that stops an approved
 * preview from exporting as something else.
 *
 * No browser is involved. The painter takes the subset of a 2D context it
 * uses, so a recording fake satisfies it.
 */
import {
  composeFrame,
  type FrameSpec,
  type MediaLayer,
} from '../src/lib/compose.js';
import {
  cropScale,
  overlayFilters,
  photoZoomChain,
} from '../src/lib/filtergraph.js';
import { cssColour, cssFont, paintFrame, type Painter2D } from '../src/web/paint.js';
import { Theme } from '../src/domain/workspace.js';
import type { Shot } from '../src/lib/store.js';

let pass = 0;
let fail = 0;
const ok = (c: boolean, what: string, extra = '') => {
  if (c) {
    pass += 1;
    console.log(`  ok    ${what}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${what}${extra ? `\n          ${extra}` : ''}`);
  }
};
const eq = (a: number, b: number, what: string) =>
  ok(Math.abs(a - b) < 1e-6, what, `expected ${b}, got ${a}`);

const theme = Theme.parse({});
const FACE = 'Inter';

// ---------------------------------------------------------------------------
// A 2D context that records instead of painting.

interface Call {
  readonly op: string;
  readonly args: readonly unknown[];
  /** State that was in effect when the call was made. */
  readonly state: Readonly<Record<string, unknown>>;
}

class Recorder implements Painter2D {
  fillStyle = '';
  strokeStyle = '';
  globalAlpha = 1;
  font = '';
  textAlign = '';
  textBaseline = '';
  lineWidth = 0;
  lineJoin = '';
  shadowColor = '';
  shadowOffsetX = 0;
  shadowOffsetY = 0;
  readonly calls: Call[] = [];
  private depth = 0;

  private snap(): Record<string, unknown> {
    return {
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      globalAlpha: this.globalAlpha,
      font: this.font,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
      lineWidth: this.lineWidth,
      shadowColor: this.shadowColor,
    };
  }
  private rec(op: string, ...args: unknown[]): void {
    this.calls.push({ op, args, state: this.snap() });
  }
  save(): void {
    this.depth += 1;
    this.rec('save');
  }
  restore(): void {
    this.depth -= 1;
    this.rec('restore');
  }
  get balanced(): boolean {
    return this.depth === 0;
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.rec('fillRect', x, y, w, h);
  }
  fillText(t: string, x: number, y: number): void {
    this.rec('fillText', t, x, y);
  }
  strokeText(t: string, x: number, y: number): void {
    this.rec('strokeText', t, x, y);
  }
  drawImage(...a: unknown[]): void {
    this.rec('drawImage', ...a);
  }
  of(op: string): Call[] {
    return this.calls.filter((c) => c.op === op);
  }
}

const shotOf = (source: Shot['source'], caption: string, seconds = 3): Shot => ({
  seconds,
  caption,
  source,
});
const paint = (spec: FrameSpec, sources: Map<string, unknown>): Recorder => {
  const r = new Recorder();
  paintFrame(r, spec, { fontFamily: FACE, sources });
  return r;
};

// ---------------------------------------------------------------------------
console.log('\ncolour and font conversion');
{
  ok(cssColour('0x0C0E13') === '#0c0e13', 'a theme colour becomes CSS hex', cssColour('0x0C0E13'));
  ok(
    cssColour('0x0C0E13', 0.82) === 'rgba(12, 14, 19, 0.82)',
    'with alpha it becomes rgba',
    cssColour('0x0C0E13', 0.82),
  );
  ok(cssColour('white') === 'white', 'a named colour passes through untouched');
  ok(cssFont(62, FACE) === '700 62px Inter', 'the font is bold at the solver size', cssFont(62, FACE));
}

console.log('\nthe ground is painted, not cleared');
{
  const spec = composeFrame({
    shot: shotOf({ kind: 'solid', label: 'CARD' }, 'WORDS'),
    index: 0,
    t: 0,
    seconds: 3,
    theme,
    source: null,
  });
  const r = paint(spec, new Map());
  const first = r.of('fillRect')[0]!;
  eq(first.args[0] as number, 0, 'the ground starts at x=0');
  eq(first.args[1] as number, 0, 'and y=0');
  eq(first.args[2] as number, spec.width, 'and covers the full width');
  eq(first.args[3] as number, spec.height, 'and the full height');
  ok(
    first.state.fillStyle === cssColour(theme.ground),
    'in the house ground colour',
    String(first.state.fillStyle),
  );
  ok(r.balanced, 'every save is matched by a restore');
}

// ---------------------------------------------------------------------------
console.log('\nfootage: the ffmpeg crop and the canvas drawImage carry the same numbers');
{
  const spec = composeFrame({
    shot: shotOf({ kind: 'clip', path: 'take.mp4', from: 0, to: 3 }, 'A LINE'),
    index: 1,
    t: 0,
    seconds: 3,
    theme,
    source: { w: 1920, h: 1080 },
  });
  const m = spec.layers.find((l): l is MediaLayer => l.kind === 'media')!;

  // The ffmpeg side, parsed back out of the generated filter string.
  const filters = cropScale(m.src, m.dst).join(',');
  const crop = /crop=(\d+):(\d+):(\d+):(\d+)/.exec(filters)!;
  const scale = /scale=(\d+):(\d+)/.exec(filters)!;
  ok(crop !== null && scale !== null, 'the filter string is explicit, not expression-based');
  ok(
    !filters.includes('force_original_aspect_ratio'),
    'and never delegates the fit to ffmpeg',
  );

  // The canvas side, recorded.
  const r = paint(spec, new Map([['take.mp4', { tag: 'frame' }]]));
  const draw = r.of('drawImage')[0]!;
  const a = draw.args as number[];

  console.log(
    `        ffmpeg crop ${crop[1]}x${crop[2]} @ ${crop[3]},${crop[4]} -> scale ${scale[1]}x${scale[2]}`,
  );
  console.log(`        canvas src ${a[3]}x${a[4]} @ ${a[1]},${a[2]} -> dst ${a[7]}x${a[8]}`);

  // The comparison. These come from two independent translations of one
  // spec and must be identical integers.
  eq(a[1]!, Number(crop[3]), 'source x agrees');
  eq(a[2]!, Number(crop[4]), 'source y agrees');
  eq(a[3]!, Number(crop[1]), 'source width agrees');
  eq(a[4]!, Number(crop[2]), 'source height agrees');
  eq(a[7]!, Number(scale[1]), 'destination width agrees');
  eq(a[8]!, Number(scale[2]), 'destination height agrees');
  eq(a[5]!, 0, 'and the destination is the whole frame, at x=0');
  eq(a[6]!, 0, 'and y=0');
}

console.log('\nthe screenshot: overlay position against drawImage destination');
{
  const spec = composeFrame({
    shot: shotOf({ kind: 'asset', path: 'shot.png' }, 'INSET'),
    index: 0,
    t: 0,
    seconds: 3,
    theme,
    source: { w: 1600, h: 900 },
  });
  const m = spec.layers.find((l): l is MediaLayer => l.kind === 'media')!;
  // This is the pair of numbers render.ts puts into its overlay filter.
  const overlayX = m.dst.x;
  const overlayY = m.dst.y;

  const r = paint(spec, new Map([['shot.png', {}]]));
  const a = r.of('drawImage')[0]!.args as number[];
  eq(a[5]!, overlayX, 'the canvas draws it at the overlay x');
  eq(a[6]!, overlayY, 'and the overlay y');
  eq(a[3]!, 1600, 'taking the whole source width -- nothing cropped');
  eq(a[4]!, 900, 'and the whole height');
}

console.log('\nthe photograph: both backends start and end at the same zoom');
{
  const source = { w: 3840, h: 2160 };
  const chain = photoZoomChain(source, 4, 0).join(',');
  // The first crop is the cover region, and must match what the solver used.
  const firstCrop = /^crop=(\d+):(\d+):(\d+):(\d+)/.exec(chain)!;
  const atZero = composeFrame({
    shot: shotOf({ kind: 'photo', path: 'me.jpg' }, '', 4),
    index: 0,
    t: 0,
    seconds: 4,
    theme,
    source,
  });
  const m0 = atZero.layers.find((l): l is MediaLayer => l.kind === 'media')!;
  eq(Number(firstCrop[1]), m0.src.w, 'the cover width agrees at t=0');
  eq(Number(firstCrop[2]), m0.src.h, 'the cover height agrees at t=0');
  eq(Number(firstCrop[3]), m0.src.x, 'and the offset');

  ok(chain.includes('eval=frame'), 'the zoom is re-evaluated every frame');
  ok(
    /scale=w='ceil\(1080\*\(1\+0\.18\*/.test(chain),
    'and is driven by the shared ZOOM_SPAN',
    chain.slice(0, 140),
  );

  // The canvas takes less of the source as the shot runs, which is the
  // same thing the scale chain does from the other direction.
  const atEnd = composeFrame({
    shot: shotOf({ kind: 'photo', path: 'me.jpg' }, '', 4),
    index: 0,
    t: 4,
    seconds: 4,
    theme,
    source,
  });
  const m1 = atEnd.layers.find((l): l is MediaLayer => l.kind === 'media')!;
  ok(m1.src.w < m0.src.w, 'the canvas crop narrows over the shot', `${m0.src.w} -> ${m1.src.w}`);
  const ratio = m0.src.w / m1.src.w;
  eq(Math.round(ratio * 1000) / 1000, 1.18, 'by exactly the zoom span');
}

// ---------------------------------------------------------------------------
console.log('\ncaptions: drawtext y against fillText y');
{
  const spec = composeFrame({
    shot: shotOf(
      { kind: 'clip', path: 'take.mp4', from: 0, to: 3 },
      'A caption long enough to wrap onto two lines',
    ),
    index: 0,
    t: 0,
    seconds: 3,
    theme,
    source: { w: 1080, h: 1920 },
  });
  const filters = overlayFilters(spec.layers, null);
  const ys = filters
    .filter((f) => f.startsWith('drawtext'))
    .map((f) => Number(/:y=(\d+)/.exec(f)![1]));

  const r = paint(spec, new Map([['take.mp4', {}]]));
  const fills = r.of('fillText');
  const canvasYs = fills.map((c) => c.args[2] as number);

  ok(ys.length >= 2, 'the caption wrapped to two or more lines', String(ys.length));
  ok(ys.length === canvasYs.length, 'both backends draw the same number of lines');
  console.log(`        ffmpeg y positions: ${ys.join(', ')}`);
  console.log(`        canvas y positions: ${canvasYs.join(', ')}`);
  ok(
    ys.every((y, i) => y === canvasYs[i]),
    'and every line is at the same height in both',
    `${ys.join(',')} vs ${canvasYs.join(',')}`,
  );

  // The text itself must match too -- one backend wrapping differently
  // would put different words on each line at the same heights.
  const ffTexts = filters
    .filter((f) => f.startsWith('drawtext'))
    .map((f) => /text='([^']*)'/.exec(f)![1]);
  const canvasTexts = fills.map((c) => c.args[0] as string);
  ok(
    ffTexts.every((t, i) => t === canvasTexts[i]),
    'with identical words on identical lines',
    `${ffTexts.join('|')} vs ${canvasTexts.join('|')}`,
  );

  // Over footage the caption is outlined, not banded.
  ok(r.of('strokeText').length === fills.length, 'each line is stroked as well as filled');
  const stroke = r.of('strokeText')[0]!;
  ok(
    stroke.state.textBaseline === 'top',
    "measured from the glyph box's top, as ffmpeg's y= means",
  );
  ok(stroke.state.textAlign === 'center', 'and centred, as ffmpeg centres');
  ok(r.of('fillRect').length === 1, 'and there is no band -- only the ground');
}

console.log('\nthe band: drawbox against fillRect');
{
  const spec = composeFrame({
    shot: shotOf({ kind: 'solid', label: 'CARD' }, 'BANDED LINE'),
    index: 0,
    t: 0,
    seconds: 3,
    theme,
    source: null,
  });
  const box = overlayFilters(spec.layers, null).find((f) => f.startsWith('drawbox'))!;
  const g = /drawbox=x=(\d+):y=(\d+):w=(\d+):h=(\d+):color=(\S+?):t=fill/.exec(box)!;

  const r = paint(spec, new Map());
  // The first fillRect is the ground; the second is the band.
  const band = r.of('fillRect')[1]!;
  const a = band.args as number[];
  console.log(`        ffmpeg drawbox ${g[3]}x${g[4]} @ ${g[1]},${g[2]}`);
  console.log(`        canvas fillRect ${a[2]}x${a[3]} @ ${a[0]},${a[1]}`);
  eq(a[0]!, Number(g[1]), 'band x agrees');
  eq(a[1]!, Number(g[2]), 'band y agrees');
  eq(a[2]!, Number(g[3]), 'band width agrees');
  eq(a[3]!, Number(g[4]), 'band height agrees');
  ok(g[5]!.includes('@0.820'), 'ffmpeg draws it translucent', g[5]!);
  ok(
    String(band.state.fillStyle).includes('0.82'),
    'and so does the canvas',
    String(band.state.fillStyle),
  );
  ok(!box.includes('box=1'), 'and it is a real rectangle, not a box sized from glyphs');
}

// ---------------------------------------------------------------------------
console.log('\ndegrading mid-scrub');
{
  // A frame for a shot whose media has not decoded yet. The preview must
  // still draw -- a scrub that throws is worse than one that shows a card.
  const spec = composeFrame({
    shot: shotOf({ kind: 'clip', path: 'take.mp4', from: 0, to: 3 }, 'WAITING'),
    index: 0,
    t: 0,
    seconds: 3,
    theme,
    source: { w: 1920, h: 1080 },
  });
  const r = paint(spec, new Map()); // nothing decoded
  ok(r.of('drawImage').length === 0, 'no media is drawn');
  ok(r.of('fillText').length > 0, 'but the caption still is');
  ok(r.of('fillRect').length >= 1, 'over the ground');
  ok(r.balanced, 'and the context is left clean');
}

console.log('\nevery shot kind paints without throwing');
{
  const kinds: Array<[string, Shot, { w: number; h: number } | null]> = [
    ['clip', shotOf({ kind: 'clip', path: 'a.mp4', from: 0, to: 3 }, 'C'), { w: 1920, h: 1080 }],
    ['photo', shotOf({ kind: 'photo', path: 'b.jpg' }, 'P'), { w: 3000, h: 4000 }],
    ['asset', shotOf({ kind: 'asset', path: 'c.png' }, 'A'), { w: 1600, h: 900 }],
    ['solid', shotOf({ kind: 'solid', label: 'L' }, 'S'), null],
  ];
  for (const [name, shot, size] of kinds) {
    const spec = composeFrame({ shot, index: 0, t: 1, seconds: 3, theme, source: size });
    const sources = new Map<string, unknown>();
    if (shot.source.kind !== 'solid') sources.set(shot.source.path, {});
    let threw = false;
    let r: Recorder | null = null;
    try {
      r = paint(spec, sources);
    } catch {
      threw = true;
    }
    ok(!threw && r !== null && r.balanced, `${name} paints cleanly`);
    ok((r?.calls.length ?? 0) > 1, `${name} actually drew something`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
