import { BufferTarget, CanvasSource, Mp4OutputFormat, Output } from 'mediabunny';
import { FRAME_FPS, FRAME_H, FRAME_W, type FrameSpec } from '../../src/lib/compose.js';
import { paintFrame, type Painter2D, type Sources } from '../../src/web/paint.js';

/**
 * The timeline, encoded in the browser.
 *
 * ── What this is for, and what it is not ─────────────────────────────
 *
 * This is the draft export: the creator presses it and has a file in a few
 * seconds without a round trip. It paints the same `FrameSpec`s the preview
 * paints, through the same painter, so what comes out is what was on screen.
 *
 * **It is silent, and that is deliberate rather than unfinished.** A reel
 * whose shots have been reordered and retimed needs its audio re-timed to
 * match, and doing that correctly means decoding, resampling and re-muxing
 * every segment. The server's ffmpeg path already does it, verified, and is
 * the path that produces the file a creator actually posts. Shipping a
 * browser export that silently dropped a creator's voice would be worse
 * than one that says so.
 *
 * So: this writes a silent draft for checking the cut, and the server
 * writes the deliverable. The UI says which is which.
 *
 * ── Backpressure ─────────────────────────────────────────────────────
 *
 * `CanvasSource.add` returns a promise that resolves when the encoder is
 * ready for more. Awaiting it is not optional: a `VideoEncoder` accepts
 * frames far faster than it encodes them, and the usual result of ignoring
 * that is a queue that grows until the tab dies.
 */

export interface ExportProgress {
  readonly frame: number;
  readonly totalFrames: number;
  readonly seconds: number;
}

export interface ExportRequest {
  /** One spec per output frame, in order. */
  readonly frames: Iterable<{ spec: FrameSpec; sources: Sources }>;
  readonly totalFrames: number;
  readonly fontFamily: string;
  /** Bits per second. 6Mbps is generous for 1080x1920 at 30fps. */
  readonly bitrate?: number;
  onProgress?(p: ExportProgress): void;
  /** Checked between frames, so a long export can be stopped. */
  shouldCancel?(): boolean;
}

export interface ExportResult {
  readonly blob: Blob;
  readonly seconds: number;
  readonly frames: number;
  /** Stated so a caller can surface it rather than discovering it. */
  readonly silent: true;
}

/** Is a browser-side export possible at all here? */
export async function canExport(): Promise<{ ok: boolean; why: string }> {
  if (typeof VideoEncoder === 'undefined') {
    return {
      ok: false,
      why:
        'This browser has no VideoEncoder. Chrome or Edge on the desktop is ' +
        'the widest support; Safari gained video in 16.4 but audio only in 26.',
    };
  }
  try {
    const support = await VideoEncoder.isConfigSupported({
      codec: 'avc1.4d0028',
      width: FRAME_W,
      height: FRAME_H,
      bitrate: 6_000_000,
      framerate: FRAME_FPS,
    });
    return support.supported
      ? { ok: true, why: '' }
      : { ok: false, why: 'This browser has no H.264 encoder for 1080x1920.' };
  } catch (e) {
    return { ok: false, why: `The encoder refused the configuration: ${String(e)}` };
  }
}

export async function exportTimeline(req: ExportRequest): Promise<ExportResult> {
  const canvas = new OffscreenCanvas(FRAME_W, FRAME_H);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('This browser would not give an OffscreenCanvas 2D context.');

  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const source = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: req.bitrate ?? 6_000_000,
  });
  output.addVideoTrack(source, { frameRate: FRAME_FPS });
  await output.start();

  const step = 1 / FRAME_FPS;
  let n = 0;
  try {
    for (const { spec, sources } of req.frames) {
      if (req.shouldCancel?.()) break;
      paintFrame(ctx as unknown as Painter2D, spec, {
        fontFamily: req.fontFamily,
        sources,
      });
      // Awaited, so the encoder sets the pace rather than the loop.
      await source.add(n * step, step);
      n += 1;
      if (n % FRAME_FPS === 0 || n === req.totalFrames) {
        req.onProgress?.({ frame: n, totalFrames: req.totalFrames, seconds: n * step });
      }
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
    silent: true,
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
