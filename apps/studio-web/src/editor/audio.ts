import type { Voice } from './sound';

/**
 * The reel's sound, mixed for export.
 *
 * The same voices the preview plays -- each clip's stretch of its own
 * decoded sound, at its volume, on the main and music tracks -- rendered
 * by an `OfflineAudioContext` to one 48 kHz stereo buffer. Hearing the
 * timeline and exporting it therefore cannot disagree about what is heard.
 *
 * Each voice fades in and out over a few milliseconds. A cut that lands
 * mid-waveform otherwise clicks, and a click at every cut is the first
 * thing that makes an edit sound amateur.
 */

export const SAMPLE_RATE = 48_000;
const FADE = 0.006;

/** Null when nothing on the timeline has sound. */
export async function mixVoices(voices: readonly Voice[], totalSeconds: number): Promise<AudioBuffer | null> {
  const audible = voices.filter((v) => v.gain > 0 && v.duration > 0);
  if (audible.length === 0 || totalSeconds <= 0) return null;
  const ctx = new OfflineAudioContext(2, Math.ceil(totalSeconds * SAMPLE_RATE), SAMPLE_RATE);
  for (const v of audible) {
    const speed = v.speed ?? 1;
    const end = Math.min(totalSeconds, v.start + v.duration);
    const length = Math.min((v.buffer.duration - v.sourceIn) / speed, end - v.start);
    if (length <= 0) continue;
    const level = ctx.createGain();
    level.gain.setValueAtTime(0, v.start);
    level.gain.linearRampToValueAtTime(v.gain, v.start + FADE);
    level.gain.setValueAtTime(v.gain, Math.max(v.start + FADE, v.start + length - FADE));
    level.gain.linearRampToValueAtTime(0, v.start + length);
    level.connect(ctx.destination);
    const node = ctx.createBufferSource();
    node.buffer = v.buffer;
    node.playbackRate.value = speed;
    node.connect(level);
    node.start(v.start, v.sourceIn, length * speed);
  }
  return ctx.startRendering();
}
