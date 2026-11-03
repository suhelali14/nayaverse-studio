import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  canEncodeAudio,
  canEncodeVideo,
  type AudioCodec,
  type VideoCodec,
} from 'mediabunny';
import { FRAME_FPS, FRAME_H, FRAME_W, type FrameSpec } from '../../../studio/src/lib/compose.js';
import { paintFrame, type Painter2D, type Sources } from '../../../studio/src/web/paint.js';

/**
 * The timeline, encoded in the browser, at the quality the creator picks.
 *
 * ── Quality ──────────────────────────────────────────────────────────
 *
 * Frames are composed in the reel's own 1080-wide coordinate space and
 * painted at the preset's scale, so a 4K export is the same layout drawn
 * at twice the resolution -- type, outlines and photos rendered sharp, not
 * a 1080p frame upscaled. Video frames come from the source at full
 * resolution (see the frame reader in ProjectEditor's export), never from
 * the preview's downscaled scrub cache.
 *
 * Each preset tries codecs in order and uses the first this machine can
 * actually encode at that size, which `canEncodeVideo` asks the browser.
 *
 * ── Sound ────────────────────────────────────────────────────────────
 *
 * The mixed timeline audio (`audio.ts`) is encoded as AAC, or Opus where
 * AAC is unavailable. A reel with no sound in it exports without a track.
 *
 * ── Backpressure ─────────────────────────────────────────────────────
 *
 * `CanvasSource.add` resolves when the encoder is ready for more. Awaiting
 * it is not optional: a `VideoEncoder` accepts frames far faster than it
 * encodes them, and ignoring that grows a queue until the tab dies.
 */

export interface ExportPreset {
  readonly id: 'draft' | 'high' | 'max';
  readonly label: string;
  readonly detail: string;
  readonly width: number;
  readonly height: number;
  readonly bitrate: number;
  /** In order of preference. */
  readonly codecs: readonly VideoCodec[];
}

export const PRESETS: readonly ExportPreset[] = [
  { id: 'draft', label: 'Draft', detail: '1080 × 1920 · 8 Mbps · quick to share for review', width: 1080, height: 1920, bitrate: 8_000_000, codecs: ['avc'] },
  { id: 'high', label: 'High', detail: '1080 × 1920 · 20 Mbps · for Reels and Shorts', width: 1080, height: 1920, bitrate: 20_000_000, codecs: ['avc', 'hevc'] },
  { id: 'max', label: 'Maximum', detail: '2160 × 3840 (4K) · 50 Mbps · archive or YouTube', width: 2160, height: 3840, bitrate: 50_000_000, codecs: ['hevc', 'avc', 'av1'] },
];

export interface PresetSupport {
  readonly preset: ExportPreset;
  /** The codec this machine will use, or null when none can encode this size. */
  readonly codec: VideoCodec | null;
}

export const CODEC_NAME: Record<VideoCodec, string> = {
  avc: 'H.264',
  hevc: 'HEVC (H.265)',
  vp9: 'VP9',
  av1: 'AV1',
  vp8: 'VP8',
  prores: 'ProRes',
};

export async function presetSupport(): Promise<PresetSupport[]> {
  if (typeof VideoEncoder === 'undefined') return PRESETS.map((preset) => ({ preset, codec: null }));
  const out: PresetSupport[] = [];
  for (const preset of PRESETS) {
    let codec: VideoCodec | null = null;
    for (const c of preset.codecs) {
      try {
        if (await canEncodeVideo(c, { width: preset.width, height: preset.height, bitrate: preset.bitrate, frameRate: FRAME_FPS })) {
          codec = c;
          break;
        }
      } catch {
        /* treated as unsupported */
      }
    }
    out.push({ preset, codec });
  }
  return out;
}

async function audioCodec(): Promise<AudioCodec | null> {
  for (const c of ['aac', 'opus'] as const) {
    try {
      if (await canEncodeAudio(c, { numberOfChannels: 2, sampleRate: 48_000, bitrate: 192_000 })) return c;
    } catch {
      /* next */
    }
  }
  return null;
}

export interface ExportProgress {
  readonly frame: number;
  readonly totalFrames: number;
  readonly seconds: number;
}

export interface ExportRequest {
  /** One spec per output frame, in order. */
  readonly frames: Iterable<{ spec: FrameSpec; sources: Sources }> | AsyncIterable<{ spec: FrameSpec; sources: Sources }>;
  readonly totalFrames: number;
  readonly fontFamily: string;
  readonly width: number;
  readonly height: number;
  readonly bitrate: number;
  readonly codec: VideoCodec;
  /** The mixed sound, or null for a silent file. */
  readonly audio: AudioBuffer | null;
  onProgress?(p: ExportProgress): void;
  /** Checked between frames, so a long export can be stopped. */
  shouldCancel?(): boolean;
}

export interface ExportResult {
  readonly blob: Blob;
  readonly seconds: number;
  readonly frames: number;
  readonly hasAudio: boolean;
  readonly cancelled: boolean;
}

/** Is a browser-side export possible at all here? */
export async function canExport(): Promise<{ ok: boolean; why: string }> {
  if (typeof VideoEncoder === 'undefined') {
    return {
      ok: false,
      why: 'This browser cannot encode video. Chrome or Edge on a desktop has the widest support.',
    };
  }
  return { ok: true, why: '' };
}

export async function exportTimeline(req: ExportRequest): Promise<ExportResult> {
  const canvas = new OffscreenCanvas(req.width, req.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('This browser would not give an OffscreenCanvas 2D context.');
  ctx.imageSmoothingQuality = 'high';
  const scaleX = req.width / FRAME_W;
  const scaleY = req.height / FRAME_H;

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const video = new CanvasSource(canvas, {
    codec: req.codec,
    bitrate: req.bitrate,
    keyFrameInterval: 2,
  });
  output.addVideoTrack(video, { frameRate: FRAME_FPS });

  let audioSource: AudioBufferSource | null = null;
  if (req.audio) {
    const codec = await audioCodec();
    if (codec) {
      audioSource = new AudioBufferSource({ codec, bitrate: 192_000 });
      output.addAudioTrack(audioSource);
    }
  }
  await output.start();

  const step = 1 / FRAME_FPS;
  let n = 0;
  let cancelled = false;
  try {
    if (audioSource && req.audio) await audioSource.add(req.audio);
    for await (const { spec, sources } of req.frames) {
      if (req.shouldCancel?.()) {
        cancelled = true;
        break;
      }
      ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
      paintFrame(ctx as unknown as Painter2D, spec, { fontFamily: req.fontFamily, sources });
      // Awaited, so the encoder sets the pace rather than the loop.
      await video.add(n * step, step);
      n += 1;
      if (n % 10 === 0 || n === req.totalFrames) {
        req.onProgress?.({ frame: n, totalFrames: req.totalFrames, seconds: n * step });
      }
    }
    if (cancelled) {
      await output.cancel();
      return { blob: new Blob(), seconds: 0, frames: n, hasAudio: false, cancelled: true };
    }
    await output.finalize();
  } catch (e) {
    try {
      await output.cancel();
    } catch {
      /* already torn down */
    }
    throw e;
  }

  const buffer = (output.target as BufferTarget).buffer;
  if (!buffer) throw new Error('The muxer produced no file.');
  return {
    blob: new Blob([buffer], { type: 'video/mp4' }),
    seconds: n * step,
    frames: n,
    hasAudio: audioSource !== null,
    cancelled: false,
  };
}

/** Hand a finished file to the person. */
export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  // Revoked on the next tick: revoking immediately cancels the download in
  // some browsers, and never revoking leaks the whole file.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
