import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from 'mediabunny';

/**
 * Sound in the editor: decoding, playback under the playhead, waveforms.
 *
 * Each file's audio is decoded once, on import, into one 48 kHz stereo
 * `AudioBuffer`. A reel's sources are short, so holding them decoded costs
 * a few megabytes and buys instant playback from any point -- there is no
 * decode between pressing play and hearing sound, and scrubbing a music
 * clip along the timeline does not touch the file again.
 */

export const RATE = 48_000;

/** The file's sound as one buffer, or null for a file with no audio. */
export async function decodeSound(file: File | Blob): Promise<AudioBuffer | null> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return null;
    const seconds = await track.computeDuration();
    if (!(seconds > 0)) return null;
    const ctx = new OfflineAudioContext(2, Math.ceil(seconds * RATE), RATE);
    let chunks = 0;
    for await (const chunk of new AudioBufferSink(track).buffers()) {
      const node = ctx.createBufferSource();
      node.buffer = chunk.buffer;
      node.connect(ctx.destination);
      node.start(Math.max(0, chunk.timestamp));
      chunks += 1;
    }
    return chunks === 0 ? null : await ctx.startRendering();
  } finally {
    input.dispose?.();
  }
}

/** Peak levels for drawing a waveform: one value 0..1 per bucket. */
export function peaksOf(buffer: AudioBuffer, perSecond = 50): Float32Array {
  const step = Math.max(1, Math.floor(buffer.sampleRate / perSecond));
  const n = Math.ceil(buffer.length / step);
  const out = new Float32Array(n);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  for (let i = 0; i < n; i += 1) {
    let peak = 0;
    const end = Math.min(buffer.length, (i + 1) * step);
    for (let j = i * step; j < end; j += 4) {
      for (const data of channels) {
        const v = Math.abs(data[j]!);
        if (v > peak) peak = v;
      }
    }
    out[i] = Math.min(1, peak);
  }
  return out;
}

export interface Voice {
  readonly buffer: AudioBuffer;
  /** Where the clip starts on the timeline, seconds. */
  readonly start: number;
  readonly duration: number;
  /** Where in the buffer the clip starts, seconds. */
  readonly sourceIn: number;
  readonly gain: number;
  /** The clip's playback speed; absent means 1. */
  readonly speed?: number;
}

/**
 * Playback that follows the playhead: schedules every voice from a point
 * on the timeline, all at once, against the audio clock, and stops them
 * all on pause or seek. Short fades at each edge so a cut does not click.
 */
export class PreviewSound {
  private ctx: AudioContext | null = null;
  private playing: AudioBufferSourceNode[] = [];

  play(from: number, voices: readonly Voice[], rate = 1): void {
    this.stop();
    if (rate <= 0 || voices.length === 0) return; // reverse plays silent
    this.ctx ??= new AudioContext({ sampleRate: RATE });
    const ctx = this.ctx;
    void ctx.resume();
    const t0 = ctx.currentTime + 0.03;
    const FADE = 0.008;
    for (const v of voices) {
      const end = v.start + v.duration;
      if (end <= from || v.gain <= 0) continue;
      const speed = v.speed ?? 1;
      const lead = Math.max(0, v.start - from) / rate;
      const offset = v.sourceIn + Math.max(0, from - v.start) * speed;
      // Timeline seconds still to play, within what the buffer holds.
      const length = Math.min((v.buffer.duration - offset) / speed, end - Math.max(from, v.start));
      if (length <= 0) continue;
      const node = ctx.createBufferSource();
      node.buffer = v.buffer;
      node.playbackRate.value = rate * speed;
      const level = ctx.createGain();
      const at = t0 + lead;
      const stopAt = at + length / rate;
      level.gain.setValueAtTime(0, at);
      level.gain.linearRampToValueAtTime(v.gain, at + FADE);
      level.gain.setValueAtTime(v.gain, Math.max(at + FADE, stopAt - FADE));
      level.gain.linearRampToValueAtTime(0, stopAt);
      node.connect(level).connect(ctx.destination);
      node.start(at, offset, length * speed);
      this.playing.push(node);
    }
  }

  stop(): void {
    for (const node of this.playing) {
      try {
        node.stop();
      } catch {
        /* never started or already stopped */
      }
    }
    this.playing = [];
  }

  close(): void {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
  }
}
