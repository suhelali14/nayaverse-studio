/**
 * Frame-exact seeking over a hardware decoder.
 *
 * ── The problem, precisely ───────────────────────────────────────────
 *
 * An HTML `<video>` element cannot be scrubbed frame by frame. The patent
 * literature on this is blunt about why: a browser "can navigate only to
 * every eighth frame in a video file", and only while that I-frame is still
 * in its buffer. An editor built on `<video>` is therefore approximate by
 * construction, and no amount of care in the UI fixes it.
 *
 * WebCodecs gives exact frames, but imposes its own rule: decoding must
 * begin at a keyframe. The naive implementation -- seek, reset the decoder,
 * feed from the nearest keyframe, flush -- is what a video-editor author
 * reported to the W3C as "pretty much unusable", because stepping back one
 * frame re-decodes from up to hundreds of frames earlier. They asked for a
 * way to flush output without restarting from a keyframe. There is none.
 *
 * ── The answer this module implements ────────────────────────────────
 *
 * Two observations, neither of which needs a change to the spec:
 *
 *   1. A decoder already positioned EARLIER IN THE SAME GOP than the target
 *      does not need resetting. The expensive thing is the reset, not the
 *      decode; feeding forward from where the decoder already sits costs
 *      only the frames actually between here and there.
 *   2. The unit worth caching is the GOP, not the frame. Decoding a GOP's
 *      keyframe at all means decoding every frame in it anyway, so keeping
 *      them makes every subsequent seek inside that GOP free -- including
 *      backwards, which is the case the naive implementation handles worst.
 *
 * So: scrubbing inside a decoded GOP costs nothing, stepping backwards
 * inside one costs nothing, and the worst case -- a jump to cold footage --
 * costs exactly one GOP's decode. The planner below is a pure function, so
 * that claim is a test rather than a hope.
 *
 * Everything here is deliberately free of WebCodecs types. The planner
 * decides; the caller drives the decoder. That is what makes the hardest
 * part of a browser video editor testable in a terminal.
 */

/**
 * One coded frame, as a demuxer reports it.
 *
 * Microseconds, because that is the unit `EncodedVideoChunk` takes, and
 * converting at the boundary is how an off-by-one-frame bug gets in.
 */
export interface Sample {
  /** Position in the track. Decode order; this product has no open GOPs. */
  readonly index: number;
  readonly timestampUs: number;
  readonly durationUs: number;
  readonly isKey: boolean;
}

/** A keyframe and the frames that depend on it. */
export interface Gop {
  /** Sample index of the keyframe. Also this GOP's identity. */
  readonly key: number;
  /** Last sample in the group, inclusive. */
  readonly last: number;
  readonly startUs: number;
  readonly endUs: number;
}

export interface TrackIndex {
  readonly samples: readonly Sample[];
  readonly gops: readonly Gop[];
}

/**
 * Group an mp4's sample table into GOPs.
 *
 * Samples before the first keyframe are not reachable -- nothing can decode
 * them -- so they are dropped rather than quietly handed to a decoder that
 * will error on them.
 */
export function indexTrack(samples: readonly Sample[]): TrackIndex {
  const gops: Gop[] = [];
  let open: { key: number; startUs: number } | null = null;

  for (const s of samples) {
    if (s.isKey) {
      if (open) {
        const prev = samples[s.index - 1]!;
        gops.push({
          key: open.key,
          last: s.index - 1,
          startUs: open.startUs,
          endUs: prev.timestampUs + prev.durationUs,
        });
      }
      open = { key: s.index, startUs: s.timestampUs };
    }
  }
  if (open && samples.length) {
    const lastSample = samples[samples.length - 1]!;
    gops.push({
      key: open.key,
      last: lastSample.index,
      startUs: open.startUs,
      endUs: lastSample.timestampUs + lastSample.durationUs,
    });
  }
  return { samples, gops };
}

/**
 * Which sample is on screen at a given instant.
 *
 * The last sample whose presentation time has arrived -- not the nearest,
 * which rounds the wrong way for half of every frame interval and is how a
 * scrub lands one frame off a cut.
 */
export function sampleAt(idx: TrackIndex, timeUs: number): number | null {
  const n = idx.samples.length;
  if (n === 0) return null;
  if (timeUs < idx.samples[0]!.timestampUs) return 0;

  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (idx.samples[mid]!.timestampUs <= timeUs) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The GOP a sample belongs to. */
export function gopOf(idx: TrackIndex, sample: number): Gop | null {
  for (let i = idx.gops.length - 1; i >= 0; i -= 1) {
    const g = idx.gops[i]!;
    if (sample >= g.key && sample <= g.last) return g;
  }
  return null;
}

export interface SeekPlan {
  /** The sample wanted. Null when the track is empty. */
  readonly target: number | null;
  /** Its GOP, when there is one. */
  readonly gop: Gop | null;
  /**
   * Already decoded and held. The caller draws it and does nothing else --
   * the case that makes scrubbing feel like a native editor.
   */
  readonly fromCache: boolean;
  /**
   * The decoder must be reset before feeding. True when the target is
   * behind the decoder's position, or in a different GOP.
   */
  readonly reset: boolean;
  /** Samples to feed, in order. Empty when served from cache. */
  readonly feed: readonly number[];
  /**
   * Decoder outputs to drop before the wanted frame appears.
   *
   * Non-zero only when the decoder restarted mid-GOP, which is the price
   * WebCodecs charges for random access and cannot be avoided.
   */
  readonly discard: number;
}

export interface DecoderPosition {
  /** Last sample fed to the decoder, or null if it has been reset. */
  readonly fedThrough: number | null;
}

/**
 * How to get to a frame from wherever the decoder currently is.
 *
 * `cached` is the set of sample indices whose decoded frames the caller is
 * holding. It is consulted first, because a cache hit is the only outcome
 * that costs nothing at all.
 */
export function planSeek(
  idx: TrackIndex,
  timeUs: number,
  cached: ReadonlySet<number>,
  pos: DecoderPosition,
): SeekPlan {
  const target = sampleAt(idx, timeUs);
  if (target === null) {
    return { target: null, gop: null, fromCache: false, reset: false, feed: [], discard: 0 };
  }

  if (cached.has(target)) {
    const g = gopOf(idx, target);
    return { target, gop: g, fromCache: true, reset: false, feed: [], discard: 0 };
  }

  const gop = gopOf(idx, target);
  if (!gop) {
    // Before the first keyframe: unreachable by any decoder, so say so
    // rather than feeding samples that will error.
    return { target, gop: null, fromCache: false, reset: false, feed: [], discard: 0 };
  }

  const fed = pos.fedThrough;
  // Feeding forward is legal only if the decoder is live, inside this GOP,
  // and has not already passed the frame wanted.
  const canContinue = fed !== null && fed >= gop.key && fed < target;

  if (canContinue) {
    const feed: number[] = [];
    for (let i = fed + 1; i <= target; i += 1) feed.push(i);
    return { target, gop, fromCache: false, reset: false, feed, discard: 0 };
  }

  // The whole GOP is fed, not just up to the target: the frames past it are
  // decoded anyway as a consequence of this GOP being touched, and keeping
  // them is what makes the next scrub free. `discard` names only what comes
  // before the target, which is the genuinely wasted work.
  const feed: number[] = [];
  for (let i = gop.key; i <= gop.last; i += 1) feed.push(i);
  return { target, gop, fromCache: false, reset: true, feed, discard: target - gop.key };
}

/**
 * What a plan will cost, before paying it.
 *
 * Lets the player decide between decoding and holding the previous frame:
 * during a fast drag, a seek that costs sixty frames of decode is better
 * skipped than queued, because the user has already moved on. Without this
 * the queue grows behind the pointer and the preview lags further the
 * longer someone scrubs -- the backpressure failure every WebCodecs write-up
 * warns about, in its editor-shaped form.
 */
export function planCost(plan: SeekPlan): number {
  return plan.fromCache ? 0 : plan.feed.length;
}
