/**
 * Decoded frames, held by GOP, under a hard budget.
 *
 * ── Why a cache is not optional here ─────────────────────────────────
 *
 * `seek.ts` explains the decode cost of random access. This is the other
 * half of that answer: without somewhere to keep a decoded GOP, every seek
 * pays full price and the editor feels broken. With it, scrubbing inside
 * decoded footage costs nothing.
 *
 * ── Why it is bounded, and why it closes things ──────────────────────
 *
 * A `VideoFrame` is not an ordinary object. It holds a decoder buffer, very
 * often in GPU memory, and the garbage collector will not reclaim it. Every
 * practitioner's account of WebCodecs says the same thing: close each frame
 * or exhaust memory, usually fast. A cache of unclosed frames is therefore
 * not a cache with a leak, it is a leak with an index.
 *
 * So the budget is in FRAMES, eviction is by least-recently-used GOP, and
 * every evicted frame is closed on its way out. `close` is counted, because
 * "did we actually release them" is the one property worth asserting and
 * the one nobody checks.
 *
 * Generic over the frame type so this is testable without a browser: the
 * tests pass a fake that records its own closing.
 */

/** Anything that must be released by hand. `VideoFrame` satisfies this. */
export interface Closeable {
  close(): void;
}

interface Held<F> {
  readonly gopKey: number;
  readonly frames: Map<number, F>;
  /** Monotonic counter, not a clock: two seeks can share a millisecond. */
  used: number;
}

export class FrameCache<F extends Closeable> {
  private readonly held = new Map<number, Held<F>>();
  private readonly sampleToGop = new Map<number, number>();
  private tick = 0;
  private frames = 0;

  hits = 0;
  misses = 0;
  evictedGops = 0;
  closedFrames = 0;

  /**
   * @param budgetFrames How many decoded frames may be held at once.
   *   A 1080x1920 frame is roughly 3MB of NV12, so a budget of 120 is on
   *   the order of 350MB -- about four seconds of footage, and enough that
   *   a scrub around a cut never leaves cache.
   */
  constructor(readonly budgetFrames: number) {
    if (!Number.isInteger(budgetFrames) || budgetFrames < 1) {
      throw new Error('A frame budget must be a positive integer.');
    }
  }

  get size(): number {
    return this.frames;
  }

  /** Sample indices currently decoded. This is what `planSeek` consults. */
  get cachedSamples(): ReadonlySet<number> {
    return new Set(this.sampleToGop.keys());
  }

  has(sample: number): boolean {
    return this.sampleToGop.has(sample);
  }

  /**
   * A decoded frame, if it is held.
   *
   * Touching a frame marks its whole GOP as recently used, not just the one
   * frame: the frames either side of it are what the next scrub step will
   * ask for, so evicting them while keeping this one is exactly backwards.
   */
  get(sample: number): F | undefined {
    const gopKey = this.sampleToGop.get(sample);
    if (gopKey === undefined) {
      this.misses += 1;
      return undefined;
    }
    const entry = this.held.get(gopKey)!;
    this.tick += 1;
    entry.used = this.tick;
    this.hits += 1;
    return entry.frames.get(sample);
  }

  /**
   * Hand over a decoded GOP. The cache owns these frames from now on.
   *
   * A GOP larger than the whole budget is rejected rather than silently
   * evicting everything and then not fitting anyway -- that produced an
   * empty cache and a full decode on every single seek, which looks like a
   * slow decoder rather than a misconfigured budget.
   */
  putGop(gopKey: number, frames: Map<number, F>): void {
    if (frames.size === 0) return;
    if (frames.size > this.budgetFrames) {
      for (const f of frames.values()) {
        f.close();
        this.closedFrames += 1;
      }
      throw new Error(
        `GOP ${gopKey} has ${frames.size} frames and the budget is ` +
          `${this.budgetFrames}. Raise the budget or re-encode with shorter GOPs.`,
      );
    }

    if (this.held.has(gopKey)) this.dropGop(gopKey);
    while (this.frames + frames.size > this.budgetFrames) {
      if (!this.evictOldest(gopKey)) break;
    }

    this.tick += 1;
    this.held.set(gopKey, { gopKey, frames, used: this.tick });
    for (const sample of frames.keys()) this.sampleToGop.set(sample, gopKey);
    this.frames += frames.size;
  }

  /** @returns whether anything was evicted. */
  private evictOldest(protect: number): boolean {
    let oldest: Held<F> | null = null;
    for (const entry of this.held.values()) {
      if (entry.gopKey === protect) continue;
      if (!oldest || entry.used < oldest.used) oldest = entry;
    }
    if (!oldest) return false;
    this.dropGop(oldest.gopKey);
    this.evictedGops += 1;
    return true;
  }

  private dropGop(gopKey: number): void {
    const entry = this.held.get(gopKey);
    if (!entry) return;
    for (const [sample, frame] of entry.frames) {
      frame.close();
      this.closedFrames += 1;
      this.sampleToGop.delete(sample);
    }
    this.frames -= entry.frames.size;
    this.held.delete(gopKey);
  }

  /** Release everything. Called when the source changes or the editor closes. */
  clear(): void {
    for (const gopKey of [...this.held.keys()]) this.dropGop(gopKey);
    this.frames = 0;
  }
}
