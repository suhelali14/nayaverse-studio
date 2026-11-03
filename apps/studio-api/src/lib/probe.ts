import { spawn } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";

/**
 * How long an uploaded file actually is.
 *
 * ── Why this exists ─────────────────────────────────────────────────
 *
 * Dubbing is billed per minute of finished video, and until this module the
 * only source for that duration was the client. A browser that reported
 * zero seconds would have dubbed for free, and one that reported a large
 * number would have been overcharged -- neither of which anything would
 * have noticed, because the number arrived looking exactly like a real one.
 *
 * A figure that decides what someone is charged cannot come from the thing
 * being charged. So the server measures it.
 *
 * ── Why ffmpeg and not a parser ─────────────────────────────────────
 *
 * `ffprobe` is not shipped by `ffmpeg-static`, but `ffmpeg -i` prints the
 * stream line to stderr and exits non-zero for want of an output. That
 * non-zero exit is expected and deliberately ignored: the probe reads
 * stderr, not the status code.
 *
 * Writing a container parser instead would mean handling mp4, MOV, WebM and
 * whatever a phone produces next, which is the job `apps/studio` already
 * delegates to a library in the browser and to ffmpeg on the server.
 *
 * ── The failure mode is "unknown", never a guess ─────────────────────
 *
 * Returning null is the honest answer when the file cannot be read, and the
 * caller records `secondsSource: "unknown"` so that every row billed on a
 * number nobody verified can be found later. Guessing a plausible duration
 * here would be the worst outcome: it would bill someone for a number this
 * code invented.
 */

const ffmpegPath = ffmpegStatic as unknown as string | null;

/** Four hours. Past this the file is not a reel and something is wrong. */
const MAX_SECONDS = 4 * 60 * 60;

/**
 * Longest a probe may run.
 *
 * ffmpeg reads only the container header for this, so it is fast on a sound
 * file and slow on a malformed one. A hung probe must not hold the request
 * open, and an upload that cannot be measured in ten seconds is one whose
 * duration should be recorded as unknown rather than waited on.
 */
const TIMEOUT_MS = 10_000;

export interface ProbeResult {
  readonly seconds: number;
  readonly source: "probe";
}

export async function probeDuration(path: string): Promise<ProbeResult | null> {
  if (!ffmpegPath) return null;

  const stderr = await new Promise<string>((resolve) => {
    let out = "";
    let settled = false;
    const done = (value: string) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    // spawn, not spawnSync: this runs inside a request, and blocking the
    // event loop for a ten-second worst case would stall every other
    // request on the process.
    const child = spawn(ffmpegPath, ["-hide_banner", "-i", path], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(out);
    }, TIMEOUT_MS);

    child.stderr.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      // The duration is in the first few lines. Reading megabytes of
      // per-frame warnings from a damaged file achieves nothing.
      if (out.length > 64 * 1024) {
        child.kill("SIGKILL");
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      done("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      done(out);
    });
  });

  const match = /Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d{1,3})/.exec(stderr);
  if (!match) return null;

  const [, h, m, s, frac] = match;
  const seconds =
    Number(h) * 3600 +
    Number(m) * 60 +
    Number(s) +
    Number(frac) / 10 ** (frac?.length ?? 2);

  // A container can report a nonsensical duration, and `N/A` parses as NaN.
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return { seconds: Math.min(seconds, MAX_SECONDS), source: "probe" };
}
