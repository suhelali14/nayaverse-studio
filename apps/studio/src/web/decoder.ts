import { FrameCache, type Closeable } from './framecache.js';
import {
  planCost,
  planSeek,
  type Sample,
  type SeekPlan,
  type TrackIndex,
} from './seek.js';

/**
 * A hardware decoder, driven to an exact frame.
 *
 * ── Why the WebCodecs types are not in this file ─────────────────────
 *
 * Everything here talks to interfaces that `VideoDecoder` and
 * `EncodedVideoChunk` happen to satisfy. That is not abstraction for its
 * own sake: it is what lets the decode loop -- where the backpressure and
 * lifetime bugs actually live -- be tested in a terminal against a fake
 * codec, rather than discovered in a browser tab that has grown to four
 * gigabytes.
 *
 * The three failures this structure exists to catch, all of them reported
 * repeatedly by people who have shipped WebCodecs:
 *
 *   1. Frames never closed. The collector below owns every frame it
 *      receives and hands them all to the cache, which closes on eviction.
 *      A frame that belongs to nobody is the default outcome otherwise.
 *   2. The queue growing behind the user. A decoder accepts work far faster
 *      than it completes it, so a drag along the timeline queues decodes
 *      for positions the pointer has already left. Superseded seeks are
 *      abandoned by generation number rather than queued.
 *   3. Decoding from a non-keyframe. The planner guarantees the first
 *      chunk after a reset is a keyframe; this file never second-guesses it.
 */

/** What this needs of a decoded frame. `VideoFrame` satisfies it. */
export interface Frame extends Closeable {
  readonly timestamp: number;
}

/** What this needs of `VideoDecoder`. */
export interface Codec {
  decode(chunk: unknown): void;
  reset(): void;
  flush(): Promise<void>;
  close(): void;
  readonly decodeQueueSize: number;
}

/**
 * Everything platform-shaped, in one injectable place.
 *
 * The real implementation builds a `VideoDecoder` and `EncodedVideoChunk`;
 * the test builds a fake that emits frames synchronously.
 */
export interface CodecHost<F extends Frame> {
  /** Build a decoder already configured for this track. */
  open(onFrame: (frame: F) => void, onError: (err: Error) => void): Codec;
  /**
   * Make sure the coded bytes for these samples are in hand.
   *
   * The index is built from packet metadata alone -- reading an upload's
   * bytes to find its keyframes would mean loading the whole file to scrub
   * the first second of it. So the bytes arrive per GOP, which is also the
   * unit everything else here works in.
   */
  prepare?(samples: readonly number[]): Promise<void>;
  /** The coded bytes of one sample. Called only after `prepare`. */
  chunkFor(sample: Sample): unknown;
}

export interface SeekStats {
  /** Seeks served without touching the decoder. */
  cacheHits: number;
  /** Seeks that fed the decoder. */
  decodes: number;
  /** Frames handed to the decoder in total. */
  framesDecoded: number;
  /** Seeks abandoned because a newer one arrived. */
  abandoned: number;
  /** Decoder resets, which are the expensive event. */
  resets: number;
}

export class GopDecoder<F extends Frame> {
  private codec: Codec | null = null;
  private fedThrough: number | null = null;
  /** Bumped on every seek, so a superseded decode can tell. */
  private generation = 0;
  private collecting: F[] = [];
  private byTimestamp = new Map<number, number>();

  readonly stats: SeekStats = {
    cacheHits: 0,
    decodes: 0,
    framesDecoded: 0,
    abandoned: 0,
    resets: 0,
  };

  constructor(
    private readonly index: TrackIndex,
    private readonly host: CodecHost<F>,
    readonly cache: FrameCache<F>,
  ) {
    // Decoder output carries timestamps, not sample numbers, so the map
    // back has to be built from the index rather than guessed from order.
    for (const s of index.samples) this.byTimestamp.set(s.timestampUs, s.index);
  }

  /** What a seek to this instant would cost, without doing it. */
  planFor(timeUs: number): SeekPlan {
    return planSeek(this.index, timeUs, this.cache.cachedSamples, {
      fedThrough: this.fedThrough,
    });
  }

  /**
   * The frame visible at an instant.
   *
   * Returns null when the time falls before the first keyframe, which no
   * decoder can reach, or when a newer seek superseded this one. A caller
   * showing the previous frame on null is correct: that is what every
   * editor does while a scrub is outrunning the decoder.
   */
  async frameAt(timeUs: number): Promise<F | null> {
    const mine = ++this.generation;
    const plan = this.planFor(timeUs);
    if (plan.target === null || plan.gop === null) return null;

    if (plan.fromCache) {
      this.stats.cacheHits += 1;
      return this.cache.get(plan.target) ?? null;
    }

    this.stats.decodes += 1;
    // Fetched before the decoder is touched, so a slow read cannot leave a
    // half-fed decoder behind if a newer seek lands meanwhile.
    if (this.host.prepare) await this.host.prepare(plan.feed);
    if (plan.reset || !this.codec) {
      this.reopen();
      this.stats.resets += 1;
    }

    this.collecting = [];
    for (const sampleIndex of plan.feed) {
      const sample = this.index.samples[sampleIndex];
      if (!sample) continue;
      this.codec!.decode(this.host.chunkFor(sample));
      this.stats.framesDecoded += 1;
    }
    this.fedThrough = plan.feed.length ? plan.feed[plan.feed.length - 1]! : this.fedThrough;

    await this.codec!.flush();

    // A newer seek arrived while this one was in the decoder. Its frames
    // are still worth keeping -- they were paid for -- but this call must
    // not return a frame for a position the user has left.
    const harvested = this.collecting;
    this.collecting = [];
    this.store(plan.gop.key, harvested);
    if (mine !== this.generation) {
      this.stats.abandoned += 1;
      return null;
    }
    return this.cache.get(plan.target) ?? null;
  }

  /**
   * Hand a decoded GOP to the cache.
   *
   * A frame whose timestamp is not in the index cannot be placed, so it is
   * closed immediately rather than leaked -- that happens with open GOPs
   * and with containers whose edit lists shift presentation times.
   */
  private store(gopKey: number, frames: F[]): void {
    const map = new Map<number, F>();
    for (const frame of frames) {
      const sample = this.byTimestamp.get(frame.timestamp);
      if (sample === undefined || map.has(sample)) {
        frame.close();
        continue;
      }
      map.set(sample, frame);
    }
    if (map.size === 0) return;
    try {
      this.cache.putGop(gopKey, map);
    } catch {
      // The cache refuses a GOP larger than the whole budget and closes
      // what it was given, so there is nothing to clean up here. Swallowed
      // because a misconfigured budget must not break a scrub.
    }
  }

  private reopen(): void {
    if (this.codec) {
      // reset() before close() discards queued work rather than waiting
      // for frames nobody is going to look at.
      this.codec.reset();
      this.codec.close();
    }
    for (const f of this.collecting) f.close();
    this.collecting = [];
    this.fedThrough = null;
    this.codec = this.host.open(
      (frame) => {
        this.collecting.push(frame);
      },
      () => {
        // A decoder error leaves the pipeline unusable; the next seek
        // reopens it. Nothing is thrown at the UI, because a scrub that
        // throws is worse than one that holds the last good frame.
        this.codec = null;
        this.fedThrough = null;
      },
    );
  }

  /** How far ahead the decoder is. A caller may skip a seek when this is high. */
  get queued(): number {
    return this.codec?.decodeQueueSize ?? 0;
  }

  close(): void {
    if (this.codec) {
      this.codec.reset();
      this.codec.close();
      this.codec = null;
    }
    for (const f of this.collecting) f.close();
    this.collecting = [];
    this.cache.clear();
    this.fedThrough = null;
  }
}

/** The cost of a seek, for a caller deciding whether to take it. */
export { planCost };
