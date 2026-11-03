/**
 * The editor's core, exercised without a browser.
 *
 * Three claims are under test here, and they are the three the product
 * rests on:
 *
 *   1. One geometry solver means the preview and the export cannot
 *      disagree about where anything is.
 *   2. Frame-exact seeking over a hardware decoder is affordable, because
 *      the GOP is the unit that gets cached.
 *   3. Decoded frames are actually released, not merely dropped.
 *
 * The third is the one that would otherwise be discovered as a browser tab
 * using four gigabytes.
 */
import {
  captionLayers,
  composeFrame,
  containDst,
  coverSrc,
  photoZoom,
  wrapLines,
  FRAME_H,
  FRAME_W,
  type FrameSpec,
  type MediaLayer,
  type TextLayer,
  type FillLayer,
} from '../src/lib/compose.js';
import {
  gopOf,
  indexTrack,
  planCost,
  planSeek,
  sampleAt,
  type Sample,
} from '../src/web/seek.js';
import { FrameCache, type Closeable } from '../src/web/framecache.js';
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

// ===========================================================================
console.log('\nfitting: cover (footage and photographs)');
{
  // A landscape phone recording into a vertical frame: the sides go.
  const src = coverSrc({ w: 1920, h: 1080 }, { w: FRAME_W, h: FRAME_H });
  eq(src.h, 1080, 'full height of a landscape source is used');
  eq(src.w, Math.round(1080 * (FRAME_W / FRAME_H)), 'width is cropped to 9:16');
  eq(src.y, 0, 'no vertical crop');
  ok(src.x > 0, 'and it is centred horizontally', `x=${src.x}`);

  // Already vertical, same ratio: nothing should be cropped at all.
  const exact = coverSrc({ w: 1080, h: 1920 }, { w: FRAME_W, h: FRAME_H });
  eq(exact.x, 0, 'a 9:16 source is not cropped horizontally');
  eq(exact.y, 0, 'nor vertically');
  eq(exact.w, 1080, 'and uses its full width');
  eq(exact.h, 1920, 'and its full height');

  // Taller than 9:16: the top and bottom go.
  const tall = coverSrc({ w: 1080, h: 2400 }, { w: FRAME_W, h: FRAME_H });
  eq(tall.w, 1080, 'a very tall source keeps its width');
  ok(tall.h < 2400, 'and loses height', `h=${tall.h}`);
  ok(tall.y > 0, 'cropped from the centre, not the top', `y=${tall.y}`);

  // The property that matters for the canvas backend: never sample outside
  // the source, which draws garbage or throws depending on the browser.
  for (const s of [
    { w: 1920, h: 1080 },
    { w: 640, h: 480 },
    { w: 1080, h: 1920 },
    { w: 300, h: 4000 },
    { w: 4000, h: 300 },
  ]) {
    const r = coverSrc(s, { w: FRAME_W, h: FRAME_H });
    ok(
      r.x >= 0 && r.y >= 0 && r.x + r.w <= s.w && r.y + r.h <= s.h,
      `cover stays inside a ${s.w}x${s.h} source`,
      JSON.stringify(r),
    );
  }
}

console.log('\nfitting: contain (screenshots, which must not be cropped)');
{
  const box = { x: 40, y: 200, w: 1000, h: 1100 };
  const wide = containDst({ w: 2000, h: 1000 }, box);
  ok(wide.w <= box.w && wide.h <= box.h, 'a wide screenshot fits inside the box');
  eq(wide.w, 1000, 'limited by width');
  eq(wide.h, 500, 'height follows the aspect ratio');
  eq(wide.x, 40, 'flush with the box horizontally when width-limited');
  eq(wide.y, 200 + Math.round((1100 - 500) / 2), 'centred vertically');

  const tall = containDst({ w: 500, h: 2000 }, box);
  ok(tall.h <= box.h, 'a tall screenshot is limited by height', `h=${tall.h}`);
  eq(tall.h, 1100, 'exactly the box height');
  eq(tall.x, 40 + Math.round((1000 - tall.w) / 2), 'centred horizontally');

  // Nothing may leave the frame -- a letterboxed shot drawn past the edge
  // is the one defect a viewer reads as broken rather than as styled.
  for (const s of [
    { w: 2000, h: 1000 },
    { w: 500, h: 2000 },
    { w: 100, h: 100 },
    { w: 3840, h: 2160 },
  ]) {
    const d = containDst(s, box);
    ok(
      d.x >= box.x && d.y >= box.y && d.x + d.w <= box.x + box.w && d.y + d.h <= box.y + box.h,
      `contain stays inside the box for ${s.w}x${s.h}`,
      JSON.stringify(d),
    );
  }
}

console.log('\ncaption wrapping');
{
  ok(wrapLines('', 20).length === 0, 'an empty caption produces no lines');
  ok(wrapLines('   ', 20).length === 0, 'whitespace only produces no lines');
  const one = wrapLines('Short line', 20);
  ok(one.length === 1 && one[0] === 'Short line', 'a short caption is one line');

  const two = wrapLines('This caption is long enough to need breaking', 20);
  ok(two.length > 1, 'a long caption breaks', two.join(' | '));
  ok(
    two.every((l) => l.length <= 20 || !l.includes(' ')),
    'no line exceeds the limit unless it is a single long word',
    two.join(' | '),
  );
  ok(two.join(' ') === 'This caption is long enough to need breaking', 'no words lost');

  // A word longer than the limit cannot be broken without hyphenation
  // rules this product does not have, so it is left long on purpose.
  const huge = wrapLines('antidisestablishmentarianism', 10);
  ok(huge.length === 1, 'an unbreakable word stays on one line');
}

console.log('\ncaption layout');
{
  const banded = captionLayers('A single line', theme, true) as [FillLayer, TextLayer];
  ok(banded.length === 2, 'band plus one line', String(banded.length));
  ok(banded[0].kind === 'fill', 'the band is painted first');
  eq(banded[0].rect.x, 0, 'the band spans the full width');
  eq(banded[0].rect.w, FRAME_W, 'edge to edge');
  ok(banded[0].alpha < 1, 'and is translucent', String(banded[0].alpha));
  ok(banded[1].kind === 'text', 'then the words');
  ok(banded[1].outline === null, 'a banded caption needs no outline');
  eq(banded[1].centerX, FRAME_W / 2, 'centred');

  const open = captionLayers('A single line', theme, false) as TextLayer[];
  ok(open.length === 1, 'an unbanded caption is text alone');
  ok(open[0].outline !== null, 'and carries a per-glyph outline instead');

  // The reason the block is laid out upward: a second line must not push
  // the caption off the bottom of the frame.
  const long = captionLayers(
    'This is a deliberately long caption that will wrap onto several lines',
    theme,
    false,
  ) as TextLayer[];
  ok(long.length >= 3, 'wraps to three or more lines', String(long.length));
  const tops = long.map((l) => l.top);
  ok(
    tops.every((t, i) => i === 0 || t > tops[i - 1]!),
    'lines descend in order',
    tops.join(','),
  );
  const lastBottom = tops[tops.length - 1]! + theme.captionSize;
  ok(lastBottom < FRAME_H, 'the last line stays inside the frame', `${lastBottom}`);
  ok(tops[0]! > 0, 'and the first line does not run off the top', `${tops[0]}`);
  // Clear of the platform's own furniture along the bottom.
  ok(
    FRAME_H - lastBottom >= Math.round(FRAME_H * theme.captionFromBottom) - theme.captionSize,
    'the block ends above the reserved bottom strip',
  );
}

console.log('\nthe photograph move');
{
  eq(photoZoom(0, 0), 1, 'an even shot starts wide');
  eq(photoZoom(1, 0), 1.18, 'and ends tight');
  eq(photoZoom(0, 1), 1.18, 'an odd shot starts tight');
  eq(photoZoom(1, 1), 1, 'and ends wide');
  eq(photoZoom(0.5, 0), 1.09, 'linear in between');
  // A scrub can hand this a time outside the shot; it must not invert.
  eq(photoZoom(-5, 0), 1, 'clamped below');
  eq(photoZoom(99, 0), 1.18, 'clamped above');
  ok(photoZoom(0.3, 0) !== photoZoom(0.3, 1), 'consecutive photos drift apart');
}

// ===========================================================================
console.log('\ncomposing a frame');

const shotOf = (source: Shot['source'], caption = 'CAPTION'): Shot => ({
  seconds: 4,
  caption,
  source,
});
const media = (f: FrameSpec): MediaLayer[] =>
  f.layers.filter((l): l is MediaLayer => l.kind === 'media');
const texts = (f: FrameSpec): TextLayer[] =>
  f.layers.filter((l): l is TextLayer => l.kind === 'text');

{
  const f = composeFrame({
    shot: shotOf({ kind: 'clip', path: 'take.mp4', from: 0, to: 4 }),
    index: 0,
    t: 1,
    seconds: 4,
    theme,
    source: { w: 1920, h: 1080 },
  });
  eq(f.width, FRAME_W, 'frame width');
  eq(f.height, FRAME_H, 'frame height');
  ok(media(f).length === 1, 'footage is one media layer');
  const m = media(f)[0]!;
  eq(m.dst.w, FRAME_W, 'footage fills the frame');
  eq(m.dst.h, FRAME_H, 'in both directions');
  ok(m.src.w < 1920, 'taking a cropped region of the source', `${m.src.w}`);
  ok(texts(f).every((t) => t.outline !== null), 'captions over footage are outlined');
}
{
  const a = composeFrame({
    shot: shotOf({ kind: 'photo', path: 'me.jpg' }),
    index: 0,
    t: 0,
    seconds: 4,
    theme,
    source: { w: 3000, h: 4000 },
  });
  const b = composeFrame({
    shot: shotOf({ kind: 'photo', path: 'me.jpg' }),
    index: 0,
    t: 4,
    seconds: 4,
    theme,
    source: { w: 3000, h: 4000 },
  });
  const sa = media(a)[0]!.src;
  const sb = media(b)[0]!.src;
  ok(sb.w < sa.w, 'a photo takes less of the source as it zooms in', `${sa.w} -> ${sb.w}`);
  // The move must be a push, not a drift: the centre stays put.
  const ca = sa.x + sa.w / 2;
  const cb = sb.x + sb.w / 2;
  ok(Math.abs(ca - cb) <= 1, 'the centre of the crop does not wander', `${ca} vs ${cb}`);
  ok(sb.x >= 0 && sb.y >= 0, 'the zoomed crop stays inside the source');
  ok(sb.x + sb.w <= 3000 && sb.y + sb.h <= 4000, 'on both axes');
}
{
  const f = composeFrame({
    shot: shotOf({ kind: 'asset', path: 'shot.png' }),
    index: 0,
    t: 0,
    seconds: 3,
    theme,
    source: { w: 1600, h: 900 },
  });
  const m = media(f)[0]!;
  ok(m.dst.w < FRAME_W, 'a screenshot is inset, never full-bleed', `${m.dst.w}`);
  eq(m.src.w, 1600, 'and nothing is cropped from it');
  eq(m.src.h, 900, 'in either direction');
  ok(
    f.layers.some((l) => l.kind === 'fill'),
    'its caption gets a band, because a screenshot is light in unknown places',
  );
}
{
  const f = composeFrame({
    shot: shotOf({ kind: 'solid', label: 'A TITLE CARD' }),
    index: 0,
    t: 0,
    seconds: 3,
    theme,
    source: null,
  });
  ok(media(f).length === 0, 'a card has no media');
  ok(
    texts(f).some((t) => t.text === 'A TITLE CARD'),
    'the label is drawn',
  );
  ok(
    texts(f).some((t) => t.size === theme.labelSize),
    'at label size, not caption size',
  );
}
{
  // The degraded case: a real file the browser could not measure yet.
  const f = composeFrame({
    shot: shotOf({ kind: 'clip', path: 'take.mp4', from: 0, to: 4 }, 'STILL SHOWS'),
    index: 0,
    t: 0,
    seconds: 4,
    theme,
    source: null,
  });
  ok(media(f).length === 0, 'an unmeasured source draws no media');
  ok(
    texts(f).some((t) => t.text === 'STILL SHOWS'),
    'but the caption survives, so a scrub degrades instead of throwing',
  );
}

// ===========================================================================
console.log('\nindexing a track');

/** 30fps, a keyframe every `gop` frames -- what a phone actually produces. */
const track = (frames: number, gop: number): Sample[] =>
  Array.from({ length: frames }, (_, i) => ({
    index: i,
    timestampUs: Math.round((i * 1_000_000) / 30),
    durationUs: Math.round(1_000_000 / 30),
    isKey: i % gop === 0,
  }));

{
  const idx = indexTrack(track(300, 30));
  ok(idx.gops.length === 10, 'ten GOPs in ten seconds at one per second', String(idx.gops.length));
  eq(idx.gops[0]!.key, 0, 'the first starts at sample zero');
  eq(idx.gops[0]!.last, 29, 'and ends before the next keyframe');
  eq(idx.gops[1]!.key, 30, 'the second starts at the next keyframe');
  eq(idx.gops[9]!.last, 299, 'the last runs to the end of the track');
  ok(
    idx.gops.every((g, i) => i === 0 || g.key === idx.gops[i - 1]!.last + 1),
    'GOPs are contiguous, with no sample unreachable',
  );

  // Footage that never gets a second keyframe is normal for short clips.
  const single = indexTrack(track(12, 999));
  ok(single.gops.length === 1, 'one keyframe is one GOP');
  eq(single.gops[0]!.last, 11, 'covering every sample');
}
{
  // Samples before the first keyframe cannot be decoded by anything.
  const samples = track(10, 30).map((s, i) => ({ ...s, isKey: i === 4 }));
  const idx = indexTrack(samples);
  ok(idx.gops.length === 1, 'only the reachable part becomes a GOP');
  eq(idx.gops[0]!.key, 4, 'starting at the real keyframe');
  ok(gopOf(idx, 2) === null, 'and an earlier sample reports no GOP rather than lying');
}

console.log('\nlanding on the right frame');
{
  const idx = indexTrack(track(300, 30));
  eq(sampleAt(idx, 0)!, 0, 'time zero is the first sample');
  eq(sampleAt(idx, 1_000_000)!, 30, 'one second in is sample thirty');
  // The rounding that matters: the sample ON SCREEN, not the nearest one.
  const justBefore = Math.round((30 * 1_000_000) / 30) - 1;
  eq(sampleAt(idx, justBefore)!, 29, 'a microsecond before a frame is still the previous frame');
  eq(sampleAt(idx, 99_000_000)!, 299, 'past the end clamps to the last sample');
  eq(sampleAt(idx, -5)!, 0, 'before the start clamps to the first');
  ok(sampleAt(indexTrack([]), 0) === null, 'an empty track has no sample');
}

// ===========================================================================
console.log('\nplanning a seek');
{
  const idx = indexTrack(track(300, 30));
  const cold = new Set<number>();

  // Cold jump into the middle: one GOP of decode, and the work before the
  // target is the part that is genuinely wasted.
  const p = planSeek(idx, 3_500_000, cold, { fedThrough: null });
  eq(p.target!, 105, 'lands on sample 105');
  eq(p.gop!.key, 90, 'in the GOP starting at 90');
  ok(p.reset, 'a cold decoder must be reset');
  eq(p.feed.length, 30, 'the whole GOP is fed, because it decodes anyway');
  eq(p.feed[0]!, 90, 'starting at the keyframe, as WebCodecs requires');
  eq(p.discard, 15, 'fifteen frames of genuinely wasted decode');

  // The case the naive implementation gets wrong: stepping FORWARD inside
  // the GOP the decoder is already in.
  const fwd = planSeek(idx, 3_600_000, cold, { fedThrough: 105 });
  eq(fwd.target!, 108, 'three frames later');
  ok(!fwd.reset, 'no reset -- the decoder is already in this GOP and behind us');
  eq(fwd.feed.length, 3, 'only the three frames between here and there');
  eq(fwd.discard, 0, 'and nothing is wasted');

  // Stepping BACKWARD with nothing cached is the expensive case, and the
  // one the W3C issue is about. It costs a GOP; it cannot cost less.
  const back = planSeek(idx, 3_400_000, cold, { fedThrough: 105 });
  eq(back.target!, 102, 'three frames earlier');
  ok(back.reset, 'which forces a reset');
  eq(back.feed.length, 30, 'and a full GOP decode');

  // Crossing into a different GOP always resets, even going forward.
  const cross = planSeek(idx, 4_200_000, cold, { fedThrough: 105 });
  eq(cross.gop!.key, 120, 'a later GOP');
  ok(cross.reset, 'crossing a keyframe boundary resets');

  // A cache hit is the outcome that costs nothing.
  const warm = new Set<number>([102]);
  const hit = planSeek(idx, 3_400_000, warm, { fedThrough: 105 });
  ok(hit.fromCache, 'a held frame is served from cache');
  ok(!hit.reset && hit.feed.length === 0, 'with no decode at all');
  eq(planCost(hit), 0, 'and zero cost');
  eq(planCost(back), 30, 'against thirty for the same seek cold');
}

// ===========================================================================
console.log('\nthe cost claim, measured');
{
  // This is the headline. Step backward frame by frame through a GOP --
  // the exact pattern reported to the W3C as unusable -- and count decodes
  // with and without the GOP cache.
  const idx = indexTrack(track(300, 30));
  const us = (sample: number) => Math.round((sample * 1_000_000) / 30);

  let naive = 0;
  for (let s = 119; s >= 90; s -= 1) {
    // Without a cache, every backward step resets and re-decodes.
    const plan = planSeek(idx, us(s), new Set(), { fedThrough: s + 1 });
    naive += planCost(plan);
  }

  let cached = 0;
  const held = new Set<number>();
  let fedThrough: number | null = null;
  for (let s = 119; s >= 90; s -= 1) {
    const plan = planSeek(idx, us(s), held, { fedThrough });
    cached += planCost(plan);
    if (!plan.fromCache) {
      for (const f of plan.feed) held.add(f);
      fedThrough = plan.feed.length ? plan.feed[plan.feed.length - 1]! : fedThrough;
    }
  }

  console.log(`        thirty backward steps: ${naive} decodes naive, ${cached} cached`);
  eq(naive, 900, 'the naive path decodes 900 frames to step back 30');
  eq(cached, 30, 'the GOP cache decodes 30 -- each frame exactly once');
  ok(naive / cached === 30, 'a thirtyfold reduction, which is the whole feature');
}
{
  // And the ordinary case: dragging the playhead forward through footage.
  const idx = indexTrack(track(300, 30));
  const held = new Set<number>();
  let fedThrough: number | null = null;
  let decodes = 0;
  for (let s = 0; s < 300; s += 1) {
    const plan = planSeek(idx, Math.round((s * 1_000_000) / 30), held, { fedThrough });
    decodes += planCost(plan);
    if (!plan.fromCache) {
      for (const f of plan.feed) held.add(f);
      fedThrough = plan.feed.length ? plan.feed[plan.feed.length - 1]! : fedThrough;
    }
  }
  eq(decodes, 300, 'playing ten seconds decodes each frame once and no more');
}

// ===========================================================================
console.log('\nthe frame cache releases what it drops');

class FakeFrame implements Closeable {
  closed = false;
  constructor(readonly id: number) {}
  close(): void {
    if (this.closed) throw new Error(`frame ${this.id} closed twice`);
    this.closed = true;
  }
}
const gopFrames = (key: number, n: number): Map<number, FakeFrame> => {
  const m = new Map<number, FakeFrame>();
  for (let i = 0; i < n; i += 1) m.set(key + i, new FakeFrame(key + i));
  return m;
};

{
  const cache = new FrameCache<FakeFrame>(60);
  cache.putGop(0, gopFrames(0, 30));
  cache.putGop(30, gopFrames(30, 30));
  eq(cache.size, 60, 'two GOPs fill the budget exactly');
  ok(cache.has(15) && cache.has(45), 'both are held');
  eq(cache.closedFrames, 0, 'and nothing has been released yet');

  // A third GOP must evict, and eviction must release.
  const third = gopFrames(60, 30);
  cache.putGop(60, third);
  eq(cache.size, 60, 'the budget is still respected');
  eq(cache.evictedGops, 1, 'one GOP was evicted');
  eq(cache.closedFrames, 30, 'and its thirty frames were closed');
  ok(!cache.has(15), 'the least recently used GOP is the one that went');
  ok(cache.has(45) && cache.has(75), 'the others survive');
}
{
  // Least-recently-USED, not inserted: touching a frame must protect its
  // whole GOP, because its neighbours are what the next scrub step wants.
  const cache = new FrameCache<FakeFrame>(60);
  cache.putGop(0, gopFrames(0, 30));
  cache.putGop(30, gopFrames(30, 30));
  ok(cache.get(10) !== undefined, 'read a frame from the older GOP');
  cache.putGop(60, gopFrames(60, 30));
  ok(cache.has(10), 'the GOP that was read survives');
  ok(!cache.has(40), 'and the untouched one is evicted instead');
  eq(cache.hits, 1, 'one hit recorded');
}
{
  const cache = new FrameCache<FakeFrame>(60);
  const frames = gopFrames(0, 30);
  cache.putGop(0, frames);
  cache.clear();
  eq(cache.size, 0, 'clearing empties the cache');
  ok([...frames.values()].every((f) => f.closed), 'and closes every frame it held');
}
{
  // A GOP bigger than the whole budget: refuse loudly, and do not leak the
  // frames on the way out.
  const cache = new FrameCache<FakeFrame>(10);
  const big = gopFrames(0, 30);
  let threw = false;
  try {
    cache.putGop(0, big);
  } catch (e) {
    threw = true;
    ok(
      String(e).includes('Raise the budget'),
      'the error says what to do about it',
      String(e),
    );
  }
  ok(threw, 'an oversized GOP is refused rather than silently thrashing');
  ok([...big.values()].every((f) => f.closed), 'and its frames are still released');
  eq(cache.size, 0, 'leaving the cache empty');
}
{
  // Re-decoding a GOP already held must not double the count or leak.
  const cache = new FrameCache<FakeFrame>(60);
  const first = gopFrames(0, 30);
  cache.putGop(0, first);
  cache.putGop(0, gopFrames(0, 30));
  eq(cache.size, 30, 'replacing a GOP does not grow the cache');
  ok([...first.values()].every((f) => f.closed), 'and the superseded frames are closed');
}
{
  let threw = false;
  try {
    new FrameCache<FakeFrame>(0);
  } catch {
    threw = true;
  }
  ok(threw, 'a zero budget is rejected at construction');
}

// ===========================================================================
console.log('\nthe cache and the planner agree');
{
  // The integration that matters: the planner's idea of what is cached has
  // to be the cache's idea, or the player decodes frames it already holds.
  const idx = indexTrack(track(300, 30));
  const cache = new FrameCache<FakeFrame>(90);
  let fedThrough: number | null = null;
  let decodes = 0;

  const seek = (sample: number) => {
    const plan = planSeek(
      idx,
      Math.round((sample * 1_000_000) / 30),
      cache.cachedSamples,
      { fedThrough },
    );
    decodes += planCost(plan);
    if (!plan.fromCache && plan.feed.length) {
      cache.putGop(plan.gop!.key, gopFrames(plan.gop!.key, plan.feed.length));
      fedThrough = plan.feed[plan.feed.length - 1]!;
    }
    return plan;
  };

  seek(105);
  eq(decodes, 30, 'a cold seek costs one GOP');
  seek(100);
  eq(decodes, 30, 'and a backward step inside it costs nothing');
  seek(119);
  eq(decodes, 30, 'nor does a forward step inside it');
  const far = seek(5);
  eq(decodes, 60, 'a jump to the start costs one more GOP');
  ok(far.reset, 'which required a reset');
  seek(105);
  eq(decodes, 60, 'and returning is free, because both GOPs still fit');

  eq(cache.size, 60, 'two GOPs held');
  ok(cache.closedFrames === 0, 'with nothing evicted yet under a 90-frame budget');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
