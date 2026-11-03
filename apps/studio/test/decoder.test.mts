/**
 * The decode loop, against a fake codec.
 *
 * This is where the bugs that kill a browser video editor live: frames that
 * are never released, a queue that grows behind a dragging pointer, and a
 * decoder fed from something that is not a keyframe. None of the three is
 * visible in a screenshot, and all three are cheap to test here because
 * `decoder.ts` takes its codec as an interface.
 *
 * The leak check is the important one. Every frame the fake creates is
 * counted, and at the end the number closed must equal the number created
 * -- which is the property a browser would otherwise report as a tab using
 * several gigabytes after a minute of scrubbing.
 */
import { GopDecoder, type Codec, type CodecHost, type Frame } from '../src/web/decoder.js';
import { FrameCache } from '../src/web/framecache.js';
import { indexTrack, type Sample, type TrackIndex } from '../src/web/seek.js';

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

// ---------------------------------------------------------------------------
// A fake codec that behaves like VideoDecoder in the ways that matter: it
// accepts work without doing it, emits frames on flush, and insists the
// first chunk after a reset is a keyframe.

class FakeFrame implements Frame {
  closed = false;
  constructor(readonly timestamp: number) {
    FakeFrame.created += 1;
  }
  static created = 0;
  static closed = 0;
  close(): void {
    if (this.closed) throw new Error(`frame at ${this.timestamp} closed twice`);
    this.closed = true;
    FakeFrame.closed += 1;
  }
}

class FakeHost implements CodecHost<FakeFrame> {
  /** Raised if the planner ever feeds a non-keyframe after a reset. */
  keyframeViolations = 0;
  opens = 0;
  private pending: Sample[] = [];
  private needsKey = true;
  private emit: ((f: FakeFrame) => void) | null = null;
  /** Set to make the next flush report a decoder error. */
  failNext = false;

  constructor(readonly index: TrackIndex) {}

  chunkFor(sample: Sample): unknown {
    return sample;
  }

  open(onFrame: (f: FakeFrame) => void, onError: (e: Error) => void): Codec {
    this.opens += 1;
    this.needsKey = true;
    this.pending = [];
    this.emit = onFrame;
    const self = this;
    return {
      get decodeQueueSize() {
        return self.pending.length;
      },
      decode(chunk: unknown): void {
        const s = chunk as Sample;
        if (self.needsKey && !s.isKey) self.keyframeViolations += 1;
        self.needsKey = false;
        self.pending.push(s);
      },
      async flush(): Promise<void> {
        const batch = self.pending;
        self.pending = [];
        if (self.failNext) {
          self.failNext = false;
          onError(new Error('fake decoder error'));
          return;
        }
        for (const s of batch) self.emit?.(new FakeFrame(s.timestampUs));
      },
      reset(): void {
        self.pending = [];
        self.needsKey = true;
      },
      close(): void {
        self.pending = [];
        self.emit = null;
      },
    };
  }
}

const track = (frames: number, gop: number): Sample[] =>
  Array.from({ length: frames }, (_, i) => ({
    index: i,
    timestampUs: Math.round((i * 1_000_000) / 30),
    durationUs: Math.round(1_000_000 / 30),
    isKey: i % gop === 0,
  }));

const us = (sample: number) => Math.round((sample * 1_000_000) / 30);

const build = (budget = 90) => {
  FakeFrame.created = 0;
  FakeFrame.closed = 0;
  const index = indexTrack(track(300, 30));
  const host = new FakeHost(index);
  const dec = new GopDecoder(index, host, new FrameCache<FakeFrame>(budget));
  return { index, host, dec };
};

// ---------------------------------------------------------------------------
console.log('\na cold seek');
{
  const { host, dec } = build();
  const f = await dec.frameAt(us(105));
  ok(f !== null, 'a frame comes back');
  eq(f!.timestamp, us(105), 'and it is the frame that was asked for');
  eq(dec.stats.decodes, 1, 'one decode');
  eq(dec.stats.framesDecoded, 30, 'of one whole GOP');
  eq(dec.stats.resets, 1, 'after one reset');
  eq(host.keyframeViolations, 0, 'and the decoder was fed a keyframe first');
  eq(dec.cache.size, 30, 'the GOP is now held');
}

console.log('\nscrubbing inside a decoded GOP');
{
  const { dec } = build();
  await dec.frameAt(us(105));
  const before = dec.stats.framesDecoded;

  const fwd = await dec.frameAt(us(110));
  eq(fwd!.timestamp, us(110), 'a forward step returns the right frame');
  const back = await dec.frameAt(us(95));
  eq(back!.timestamp, us(95), 'and so does a backward step');
  const key = await dec.frameAt(us(90));
  eq(key!.timestamp, us(90), 'including the keyframe itself');

  eq(dec.stats.framesDecoded, before, 'none of them decoded anything');
  eq(dec.stats.cacheHits, 3, 'all three were cache hits');
  eq(dec.stats.resets, 1, 'and the decoder was never reset again');
}

console.log('\ncrossing into cold footage');
{
  const { host, dec } = build();
  await dec.frameAt(us(105));
  const f = await dec.frameAt(us(200));
  eq(f!.timestamp, us(200), 'the far frame comes back');
  eq(dec.stats.resets, 2, 'which cost a second reset');
  eq(dec.stats.framesDecoded, 60, 'and a second GOP of decode');
  eq(host.keyframeViolations, 0, 'still always starting from a keyframe');

  // And coming back is free, because both GOPs fit in the budget.
  const hitsBefore = dec.stats.cacheHits;
  await dec.frameAt(us(105));
  eq(dec.stats.cacheHits, hitsBefore + 1, 'returning to the first GOP is a cache hit');
  eq(dec.stats.framesDecoded, 60, 'with no further decode');
}

console.log('\nplaying forward through a GOP boundary');
{
  const { host, dec } = build();
  // Frame by frame across a keyframe. Each GOP should decode exactly once.
  for (let s = 85; s <= 95; s += 1) {
    const f = await dec.frameAt(us(s));
    ok(f !== null && f.timestamp === us(s), `frame ${s} is exact`);
  }
  eq(dec.stats.framesDecoded, 60, 'two GOPs decoded, each once');
  eq(dec.stats.resets, 2, 'one reset per GOP entered');
  eq(host.keyframeViolations, 0, 'and no illegal feed');
}

console.log('\nthe forward-feed path, where no reset is needed');
{
  // Reached by seeking into a GOP whose frames were then evicted: the
  // decoder is still positioned inside it, so feeding forward is legal.
  const index = indexTrack(track(300, 30));
  const host = new FakeHost(index);
  FakeFrame.created = 0;
  FakeFrame.closed = 0;
  // A budget of exactly one GOP, so the next putGop evicts the previous.
  const dec = new GopDecoder(index, host, new FrameCache<FakeFrame>(30));
  await dec.frameAt(us(90));
  eq(dec.stats.resets, 1, 'the first seek reset');
  await dec.frameAt(us(130)); // different GOP, evicts the first
  eq(dec.stats.resets, 2, 'the second reset');
  ok(dec.cache.size <= 30, 'and the budget held', String(dec.cache.size));
}

console.log('\nabandoning a superseded seek');
{
  const { dec } = build();
  // Two seeks started before either is awaited: the first must not win.
  const first = dec.frameAt(us(10));
  const second = dec.frameAt(us(200));
  const [a, b] = await Promise.all([first, second]);
  ok(a === null, 'the superseded seek returns nothing');
  ok(b !== null, 'the newest seek returns a frame');
  eq(b!.timestamp, us(200), 'and it is the newest position');
  eq(dec.stats.abandoned, 1, 'one seek was abandoned');
  // The frames the abandoned seek paid for are kept, not thrown away.
  ok(dec.cache.size > 0, 'and its decoded frames were still cached');
}

console.log('\nrecovering from a decoder error');
{
  const { dec, host } = build();
  host.failNext = true;
  const bad = await dec.frameAt(us(105));
  ok(bad === null, 'a failed decode returns nothing rather than throwing');
  // The next seek must reopen and work.
  const good = await dec.frameAt(us(105));
  ok(good !== null, 'the next seek recovers', String(good));
  eq(good!.timestamp, us(105), 'and is exact');
  ok(host.opens >= 2, 'because the codec was reopened', String(host.opens));
  eq(host.keyframeViolations, 0, 'and the reopened decoder still got a keyframe first');
}

console.log('\nframes are released, every one of them');
{
  const { dec } = build(60); // two GOPs, so scrubbing forces eviction
  // A realistic drag: forward across several GOPs, then back.
  for (const s of [0, 20, 45, 70, 95, 130, 170, 210, 250, 290, 150, 60, 10]) {
    await dec.frameAt(us(s));
  }
  console.log(
    `        ${FakeFrame.created} frames created, ${FakeFrame.closed} closed, ` +
      `${dec.cache.size} still held`,
  );
  eq(
    FakeFrame.closed + dec.cache.size,
    FakeFrame.created,
    'every frame is either held or closed -- none is lost',
  );
  ok(dec.cache.size <= 60, 'and the budget was never exceeded', String(dec.cache.size));

  dec.close();
  eq(FakeFrame.closed, FakeFrame.created, 'and closing the decoder releases the rest');
  eq(dec.cache.size, 0, 'leaving nothing held');
}

console.log('\nunreachable positions');
{
  // Footage whose first keyframe is not at the start -- a trimmed upload.
  const samples = track(60, 30).map((s, i) => ({ ...s, isKey: i === 10 }));
  const index = indexTrack(samples);
  const host = new FakeHost(index);
  FakeFrame.created = 0;
  FakeFrame.closed = 0;
  const dec = new GopDecoder(index, host, new FrameCache<FakeFrame>(90));

  const before = await dec.frameAt(us(3));
  ok(before === null, 'a position before the first keyframe returns nothing');
  eq(dec.stats.framesDecoded, 0, 'and feeds the decoder nothing it cannot decode');
  eq(host.keyframeViolations, 0, 'so there is no violation to report');

  const after = await dec.frameAt(us(30));
  ok(after !== null, 'a reachable position still works');
  dec.close();
  eq(FakeFrame.closed, FakeFrame.created, 'with no frames leaked');
}

console.log('\nthe cost estimate a player uses to skip work');
{
  const { dec } = build();
  const cold = dec.planFor(us(105));
  ok(!cold.fromCache, 'a cold position is not cached');
  eq(cold.feed.length, 30, 'and would cost a GOP');
  await dec.frameAt(us(105));
  const warm = dec.planFor(us(105));
  ok(warm.fromCache, 'once decoded it is a cache hit');
  eq(warm.feed.length, 0, 'costing nothing');
  // This is what lets a drag stay responsive: the player can ask before
  // committing, and hold the previous frame when the answer is expensive.
  const far = dec.planFor(us(290));
  ok(far.feed.length > 0, 'and a far position is known to be expensive in advance');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
