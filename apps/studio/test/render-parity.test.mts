/**
 * Does the exported file actually agree with the geometry solver?
 *
 * Every other test in this repo checks TypeScript against TypeScript. This
 * one renders a real mp4 with real ffmpeg and then reads its pixels back,
 * because the whole claim of `compose.ts` is that ffmpeg puts things where
 * the solver said -- and the only way to know is to look.
 *
 * The test assets are built to make that checkable. A four-quadrant clip
 * means a centre crop can be verified by which colour lands where; a flat
 * screenshot means the letterbox edges can be found to the pixel. A pretty
 * test video would prove nothing.
 *
 * This is the test that would have caught all five of the silent ffmpeg
 * failures this project has already hit, each of which exited zero.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { renderPost } from '../src/lib/render.js';
import {
  FRAME_H,
  FRAME_W,
  captionLayers,
  composeFrame,
  containDst,
  coverSrc,
  photoZoom,
  type MediaLayer,
} from '../src/lib/compose.js';
import { Theme } from '../src/domain/workspace.js';
import type { Post } from '../src/lib/store.js';

const FF = ffmpegStatic as unknown as string;
const theme = Theme.parse({});

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
const eq = (a: number, b: number, what: string, tol = 1e-6) =>
  ok(Math.abs(a - b) <= tol, what, `expected ${b}, got ${a}`);

// A scratch folder per run. The test builds every asset it reads, so it
// needs no one's workspace -- and must not write into one.
const SCRATCH = join(tmpdir(), `studio-parity-${process.pid}`);
const ASSETS = join(SCRATCH, 'assets');
const OUT = join(SCRATCH, 'out');
mkdirSync(ASSETS, { recursive: true });

const ff = (args: string[], label: string) => {
  const r = spawnSync(FF, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    const tail = r.stderr.toString('utf8').trimEnd().split('\n').slice(-4).join('\n');
    throw new Error(`${label} failed:\n${tail}`);
  }
  return r;
};

// ---------------------------------------------------------------------------
console.log('\nbuilding assets whose geometry can be read from pixels');

const QUAD = join(ASSETS, 'quad.mp4');
const FLAT = join(ASSETS, 'flat.png');
const PHOTO = join(ASSETS, 'me.jpg');

// Four quadrants. A centre crop to 9:16 straddles the vertical midline, so
// which colour appears on which side proves the crop offset exactly.
const QUADS = {
  tl: [220, 40, 40],
  tr: [40, 200, 60],
  bl: [50, 70, 220],
  br: [230, 200, 50],
} as const;
const hex = (c: readonly number[]) =>
  `0x${c.map((n) => n.toString(16).padStart(2, '0')).join('')}`;

ff(
  [
    '-y',
    '-f', 'lavfi', '-i', `color=c=${hex(QUADS.tl)}:s=960x540:r=30:d=9`,
    '-f', 'lavfi', '-i', `color=c=${hex(QUADS.tr)}:s=960x540:r=30:d=9`,
    '-f', 'lavfi', '-i', `color=c=${hex(QUADS.bl)}:s=960x540:r=30:d=9`,
    '-f', 'lavfi', '-i', `color=c=${hex(QUADS.br)}:s=960x540:r=30:d=9`,
    '-f', 'lavfi', '-i', 'sine=frequency=330:duration=9',
    '-filter_complex',
    '[0:v][1:v]hstack[top];[2:v][3:v]hstack[bot];[top][bot]vstack[v]',
    '-map', '[v]', '-map', '4:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-shortest', QUAD,
  ],
  'quad clip',
);
// A flat screenshot: any scaler produces the same colour, so the letterbox
// edges are findable to the pixel.
const SHOT_RGB = [27, 36, 48] as const;
ff(
  ['-y', '-f', 'lavfi', '-i', `color=c=${hex(SHOT_RGB)}:s=1600x900`, '-frames:v', '1', FLAT],
  'flat screenshot',
);
ok(existsSync(QUAD) && existsSync(FLAT), 'test assets built');
// A detailed stand-in for a creator's photo. The motion checks below need
// texture to see movement; a real person's picture has no place in a test.
ff(['-y', '-f', 'lavfi', '-i', 'testsrc2=s=1080x1350', '-frames:v', '1', PHOTO], 'stand-in photograph');
ok(existsSync(PHOTO), 'a photograph to move');

// ---------------------------------------------------------------------------
console.log('\nrendering a reel through the real pipeline');

const post: Post = {
  id: 'parity-001',
  channel: 'main',
  language: 'en',
  status: 'approved',
  premise: 'p',
  forWhom: 'f',
  shots: [
    { seconds: 3, caption: 'FIRST BEAT', source: { kind: 'solid', label: 'A TITLE CARD' } },
    { seconds: 3, caption: 'SECOND BEAT', source: { kind: 'clip', path: 'quad.mp4', from: 1, to: 4 } },
    { seconds: 3, caption: 'THIRD BEAT', source: { kind: 'photo', path: 'me.jpg' } },
    { seconds: 3, caption: 'FOURTH BEAT', source: { kind: 'asset', path: 'flat.png' } },
  ],
  caption: 'c',
  createdAt: new Date().toISOString(),
};

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const started = Date.now();
const result = renderPost(post, ASSETS, OUT, theme);
const wall = (Date.now() - started) / 1000;
ok(existsSync(result.path), 'a file came out', result.path);
console.log(`        rendered 12s in ${wall.toFixed(1)}s wall clock`);
ok(result.warnings.length === 0, 'with no warnings', result.warnings.join(' | '));

// Measured, not assumed: the reel's real length, from the container.
const probe = spawnSync(FF, ['-hide_banner', '-i', result.path], { encoding: 'utf8' });
const durMatch = /Duration: (\d+):(\d+):([\d.]+)/.exec(probe.stderr ?? '');
ok(durMatch !== null, 'the container reports a duration');
if (durMatch) {
  const secs =
    Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3]);
  console.log(`        duration ${secs.toFixed(2)}s`);
  eq(secs, 12, 'twelve seconds, as the four shots sum to', 0.25);
}

// ---------------------------------------------------------------------------
// Reading pixels back. Raw rgb24 rather than a PNG, so there is no decoder
// to install and no colour management to argue with.

const frameAt = (t: number): Buffer => {
  // -ss AFTER -i decodes to the exact frame. Slower, and correct, which is
  // the right trade in a test that exists to find off-by-one errors.
  const r = ff(
    [
      '-hide_banner', '-i', result.path, '-ss', String(t), '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ],
    `frame at ${t}s`,
  );
  const buf = r.stdout;
  if (buf.length < FRAME_W * FRAME_H * 3) {
    throw new Error(`frame at ${t}s came back short: ${buf.length} bytes`);
  }
  return buf;
};

const px = (buf: Buffer, x: number, y: number): [number, number, number] => {
  const i = (y * FRAME_W + x) * 3;
  return [buf[i]!, buf[i + 1]!, buf[i + 2]!];
};
/** yuv420 round-trips are not lossless; 14 per channel is comfortably inside
 *  "the same colour" and far outside "a different quadrant". */
const near = (
  got: readonly number[],
  want: readonly number[],
  tol = 14,
): boolean => got.every((v, i) => Math.abs(v - want[i]!) <= tol);
const show = (c: readonly number[]) => `rgb(${c.join(',')})`;

// The house ground, read from the theme's own default rather than written
// out: it was a literal here, and changing the default (blue-black to
// graphite) failed four checks that were testing the old number, not the
// renderer.
const GROUND_HEX = Theme.parse({}).ground;
const GROUND = [1, 3, 5].map((i) => parseInt(GROUND_HEX.slice(1 + i, 3 + i), 16)) as readonly number[];

// ---------------------------------------------------------------------------
console.log('\nthe clip: is the crop where the solver said?');
{
  const src = coverSrc({ w: 1920, h: 1080 }, { w: FRAME_W, h: FRAME_H });
  console.log(`        solver crops ${src.w}x${src.h} at x=${src.x},y=${src.y}`);
  eq(src.h, 1080, 'the full height is used');
  ok(src.x > 0 && src.x < 960, 'and the crop straddles the vertical midline', `x=${src.x}`);

  const f = frameAt(4.5); // mid-way through the second shot
  // Full bleed: a letterboxed clip would leave the ground showing in the
  // corners, which is exactly the defect `cover` exists to prevent.
  ok(!near(px(f, 4, 4), GROUND), 'the top-left corner is footage, not ground', show(px(f, 4, 4)));
  ok(
    !near(px(f, FRAME_W - 5, FRAME_H - 5), GROUND),
    'and so is the bottom-right',
    show(px(f, FRAME_W - 5, FRAME_H - 5)),
  );

  // The quadrant test. Left of centre must be the left-hand colours and
  // right of centre the right-hand ones; swap the crop offset and this
  // fails immediately.
  ok(near(px(f, 150, 300), QUADS.tl), 'top-left of frame shows the clip top-left', show(px(f, 150, 300)));
  ok(near(px(f, 930, 300), QUADS.tr), 'top-right shows the clip top-right', show(px(f, 930, 300)));
  ok(near(px(f, 150, 1300), QUADS.bl), 'bottom-left shows the clip bottom-left', show(px(f, 150, 1300)));
  ok(near(px(f, 930, 1300), QUADS.br), 'bottom-right shows the clip bottom-right', show(px(f, 930, 1300)));

  // The vertical midline of the source maps to the midline of the output
  // only because the crop is centred. Sample either side of it.
  const mid = FRAME_W / 2;
  ok(near(px(f, mid - 40, 300), QUADS.tl), 'just left of centre is still the left half');
  ok(near(px(f, mid + 40, 300), QUADS.tr), 'just right of centre is the right half');
}

console.log('\nthe screenshot: is it letterboxed exactly as the solver said?');
{
  const spec = composeFrame({
    shot: post.shots[3]!,
    index: 3,
    t: 0,
    seconds: 3,
    theme,
    source: { w: 1600, h: 900 },
  });
  const m = spec.layers.find((l): l is MediaLayer => l.kind === 'media')!;
  console.log(`        solver places it at ${m.dst.w}x${m.dst.h} @ ${m.dst.x},${m.dst.y}`);

  const f = frameAt(10.5); // mid-way through the fourth shot
  const cx = m.dst.x + Math.floor(m.dst.w / 2);
  const cy = m.dst.y + Math.floor(m.dst.h / 2);
  ok(near(px(f, cx, cy), SHOT_RGB), 'the screenshot is at the centre of its rect', show(px(f, cx, cy)));

  // The edges. Four pixels inside is the screenshot; twelve outside is the
  // ground. A scale that is off by more than a few pixels fails this.
  ok(near(px(f, cx, m.dst.y + 4), SHOT_RGB), 'present just inside its top edge');
  ok(near(px(f, cx, m.dst.y - 12), GROUND), 'and the ground just above it', show(px(f, cx, m.dst.y - 12)));
  ok(
    near(px(f, cx, m.dst.y + m.dst.h - 4), SHOT_RGB),
    'present just inside its bottom edge',
  );
  ok(
    near(px(f, cx, m.dst.y + m.dst.h + 12), GROUND),
    'and the ground just below it',
    show(px(f, cx, m.dst.y + m.dst.h + 12)),
  );

  // Nothing was cropped: the solver's contain rect must preserve the 16:9
  // aspect of the source, or the UI in the shot is stretched.
  const ratio = m.dst.w / m.dst.h;
  eq(ratio, 1600 / 900, 'the aspect ratio is preserved, so nothing is stretched', 0.01);

  // And the band behind the caption is a real rectangle at a known place.
  const band = captionLayers('FOURTH BEAT', theme, true).find((l) => l.kind === 'fill');
  ok(band !== undefined, 'the solver specifies a band for a screenshot caption');
}

console.log('\nthe photograph: does it actually move?');
{
  // The bug this catches is a dead still that exits zero -- which is what
  // the previous zoompan formulation produced, and what only a frame
  // comparison reveals.
  const early = frameAt(7.2);
  const late = frameAt(8.8);
  let differing = 0;
  for (let y = 100; y < FRAME_H - 500; y += 37) {
    for (let x = 60; x < FRAME_W - 60; x += 41) {
      if (!near(px(early, x, y), px(late, x, y), 10)) differing += 1;
    }
  }
  const sampled = Math.ceil((FRAME_H - 600) / 37) * Math.ceil((FRAME_W - 120) / 41);
  console.log(`        ${differing} of ~${sampled} sampled points changed`);
  ok(differing > sampled * 0.2, 'the frame genuinely changes across the shot', `${differing}`);

  // And it is a push, not a pan: the solver's crop must shrink about a
  // fixed centre over the shot.
  const base = coverSrc({ w: 3840, h: 2160 }, { w: FRAME_W, h: FRAME_H });
  const z0 = photoZoom(0, 2);
  const z1 = photoZoom(1, 2);
  ok(z1 !== z0, 'the solver says the zoom changes', `${z0} -> ${z1}`);
  const w0 = Math.round(base.w / z0);
  const w1 = Math.round(base.w / z1);
  ok(w1 < w0, 'taking less of the source as it pushes in', `${w0} -> ${w1}`);
  const c0 = base.x + (base.w - w0) / 2 + w0 / 2;
  const c1 = base.x + (base.w - w1) / 2 + w1 / 2;
  ok(Math.abs(c0 - c1) < 1, 'about an unmoving centre', `${c0} vs ${c1}`);
}

console.log('\nthe card');
{
  const f = frameAt(1.5);
  // A card is the ground, so its corners must be exactly that -- this is
  // also the check that the theme colour survived into the encode.
  ok(near(px(f, 20, 20), GROUND), 'the card is the house ground', show(px(f, 20, 20)));
  ok(near(px(f, FRAME_W - 20, 20), GROUND), 'across the top');

  // The label sits at a known height. Rather than recognising glyphs, scan
  // that row band for anything lighter than the ground -- text is the only
  // thing there.
  const labelTop = Math.round(FRAME_H * 0.36);
  let inked = 0;
  for (let y = labelTop; y < labelTop + theme.labelSize; y += 3) {
    for (let x = 200; x < FRAME_W - 200; x += 2) {
      const [r, g, b] = px(f, x, y);
      if (r + g + b > 180) inked += 1;
    }
  }
  ok(inked > 50, 'the label is drawn at the height the solver specified', `${inked} lit pixels`);

  // And nothing is drawn where the solver placed nothing.
  let strayAbove = 0;
  for (let y = 60; y < labelTop - 60; y += 5) {
    for (let x = 100; x < FRAME_W - 100; x += 5) {
      const [r, g, b] = px(f, x, y);
      if (r + g + b > 180) strayAbove += 1;
    }
  }
  eq(strayAbove, 0, 'and nothing above it', 0);
}

console.log('\nthe captions are where the solver put them');
{
  // Checked on the card, where the ground behind the text is known, so a
  // lit pixel can only be the caption.
  const f = frameAt(1.5);
  const lines = captionLayers('FIRST BEAT', theme, true).filter((l) => l.kind === 'text');
  ok(lines.length === 1, 'one line of caption');
  const line = lines[0]! as { top: number; size: number };
  console.log(`        solver puts the caption's top edge at y=${line.top}`);

  const lit = (y0: number, y1: number): number => {
    let n = 0;
    for (let y = y0; y < y1; y += 2) {
      for (let x = 150; x < FRAME_W - 150; x += 2) {
        const [r, g, b] = px(f, x, y);
        if (r + g + b > 300) n += 1;
      }
    }
    return n;
  };
  const inBand = lit(line.top, line.top + line.size);
  const below = lit(line.top + line.size + 40, line.top + line.size + 110);
  ok(inBand > 100, 'the caption is lit where it was specified', `${inBand}`);
  eq(below, 0, 'and there is nothing below it', 0);
  // Above the caption on a card is empty ground between label and caption.
  const above = lit(line.top - 110, line.top - 40);
  eq(above, 0, 'nor above it', 0);
}

console.log('\nthe two zoom implementations agree (measured, not asserted)');
{
  // `photoZoom` in the solver and `photoCropExpr` in the filtergraph are
  // two implementations of one formula -- ffmpeg evaluates its own
  // expression per frame, so there is no shared number to rely on. The
  // module comment claims a test holds them together. This is that test,
  // and writing it found that it had not existed: mutating `photoZoom` to
  // a constant left the rendered video still zooming, because nothing
  // compared them.
  //
  // Measured physically rather than by re-deriving the formula: a square
  // of known size in the source has a width in the output that depends
  // only on the zoom, so reading that width back gives the zoom ffmpeg
  // actually applied.
  const ZOOMSRC = join(ASSETS, 'zoomtest.png');
  const SQ = 400;
  ff(
    [
      '-y', '-f', 'lavfi', '-i', `color=c=${hex(GROUND)}:s=3840x2160`,
      '-f', 'lavfi', '-i', `color=c=0xffffff:s=${SQ}x${SQ}`,
      '-filter_complex', '[0:v][1:v]overlay=(W-w)/2:(H-h)/2[v]',
      '-map', '[v]', '-frames:v', '1', ZOOMSRC,
    ],
    'zoom probe source',
  );

  const zoomPost: Post = {
    ...post,
    id: 'parity-zoom',
    shots: [{ seconds: 4, caption: '', source: { kind: 'photo', path: 'zoomtest.png' } }],
  };
  const zr = renderPost(zoomPost, ASSETS, OUT, theme);

  /** Width of the white run across the frame's vertical centre. */
  const squareWidth = (t: number): number => {
    const r = ff(
      [
        '-hide_banner', '-i', zr.path, '-ss', String(t), '-frames:v', '1',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
      ],
      `zoom frame ${t}`,
    ).stdout;
    const y = Math.floor(FRAME_H / 2);
    let n = 0;
    for (let x = 0; x < FRAME_W; x += 1) {
      const [rr, gg, bb] = px(r, x, y);
      if (rr > 200 && gg > 200 && bb > 200) n += 1;
    }
    return n;
  };

  const base = coverSrc({ w: 3840, h: 2160 }, { w: FRAME_W, h: FRAME_H });
  /** What the solver says the square should measure at this instant. */
  const predicted = (t: number): number => {
    const z = photoZoom(t / 4, 0);
    const cropW = Math.round(base.w / z);
    return SQ * (FRAME_W / cropW);
  };

  for (const t of [0.05, 1.5, 2.5, 3.9]) {
    const got = squareWidth(t);
    const want = predicted(t);
    console.log(
      `        t=${t}s  solver predicts ${want.toFixed(1)}px, ffmpeg drew ${got}px`,
    );
    // Three pixels covers the scaler's edge feather and one frame of
    // timing slack; it is far tighter than any formula disagreement.
    ok(
      Math.abs(got - want) <= 4,
      `the zoom matches the solver at t=${t}s`,
      `predicted ${want.toFixed(1)}, measured ${got}`,
    );
  }

  // And it must genuinely travel, in the direction the solver states.
  const first = squareWidth(0.05);
  const last = squareWidth(3.9);
  ok(last > first + 40, 'the square grows across the shot, so it pushes in', `${first} -> ${last}`);
  rmSync(ZOOMSRC, { force: true });
}

console.log("\nthe creator's audio survives the join");
{
  // The clip is the only shot with real sound. Measured per segment,
  // because the concat demuxer copies streams and a mismatch shows up as
  // audio that simply stops partway through the reel.
  const level = (from: number, dur: number): number => {
    const r = spawnSync(
      FF,
      [
        '-hide_banner', '-ss', String(from), '-t', String(dur), '-i', result.path,
        '-af', 'volumedetect', '-f', 'null', '-',
      ],
      { encoding: 'utf8' },
    );
    const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr ?? '');
    return m ? Number(m[1]) : NaN;
  };
  const card = level(0.5, 2);
  const clip = level(3.5, 2);
  const photo = level(6.5, 2);
  console.log(`        card ${card} dB · clip ${clip} dB · photo ${photo} dB`);
  ok(clip > -40, "the clip carries the creator's tone", `${clip} dB`);
  ok(card < -60, 'the card is silent, not missing', `${card} dB`);
  ok(photo < -60, 'and so is the photograph', `${photo} dB`);
  ok(clip - card > 30, 'a clear difference, so the track is really per-shot');
}

rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
