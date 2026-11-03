/**
 * Time, written the two ways this editor shows it.
 *
 * `formatClock` is for people: "00:04.2", tenths, because a shot's start is
 * read to the tenth when scanning a running order. `formatTimecode` is the
 * broadcast form, "00:00:04:06" with a frame field, for the monitor -- the
 * one place a creator steps frame by frame and needs to see which frame.
 */

export function formatClock(seconds: number): string {
  const safe = Math.max(0, seconds);
  const m = Math.floor(safe / 60);
  const s = safe - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

export function formatTimecode(seconds: number, fps: number): string {
  const totalFrames = Math.max(0, Math.round(seconds * fps));
  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(h)}:${two(m)}:${two(s)}:${two(frames)}`;
}
