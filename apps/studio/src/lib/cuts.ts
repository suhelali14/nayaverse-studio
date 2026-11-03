import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import ffmpegStatic from 'ffmpeg-static';
import type { Post, Shot } from './store.js';

/**
 * Where to cut a creator's upload so it matches the script.
 *
 * ── What this does not pretend to do ─────────────────────────────────
 *
 * It does not know which words are spoken when. Finding the moment a
 * particular line is said needs a transcript, which needs speech to text,
 * which is a paid dependency and a per-minute cost. Until that exists,
 * this allocates the footage across the beats in proportion to how long
 * each beat is, which is right when somebody filmed to the script in one
 * take and wrong the moment they did not.
 *
 * That is stated plainly rather than hidden behind a word like "smart",
 * because the failure mode is a reel where the captions do not match what
 * the person is saying, and a creator needs to know to check rather than
 * to trust. Every cut here is a starting point for a human to drag.
 */

const ffmpegPath = ffmpegStatic as unknown as string | null;

/** How long an uploaded file runs, or null if ffmpeg cannot read it. */
export function durationOf(file: string): number | null {
  if (!ffmpegPath || !existsSync(file)) return null;
  const r = spawnSync(ffmpegPath, ['-i', file, '-hide_banner'], { encoding: 'utf8' });
  // ffmpeg exits non-zero when given no output, and prints what we want to
  // stderr regardless, so the status is deliberately not checked here.
  const m = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(r.stderr ?? '');
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export interface CutPlan {
  readonly shots: Shot[];
  readonly warnings: string[];
}

/**
 * Beats against footage, proportionally.
 *
 * Beats that already name an asset or a card are left exactly as they are:
 * an art director that chose a photograph for the closing beat should not
 * have it replaced by whatever happens to be at that timestamp.
 */
export function planCuts(post: Post, uploadPath: string, uploadSeconds: number): CutPlan {
  const warnings: string[] = [];
  const takeable = post.shots.filter((s) => s.source.kind === 'solid');

  if (takeable.length === 0) {
    warnings.push('Every beat already has a source, so the upload was not used.');
    return { shots: [...post.shots], warnings };
  }

  const wanted = takeable.reduce((n, s) => n + s.seconds, 0);
  if (uploadSeconds < wanted) {
    warnings.push(
      `The script needs ${wanted}s of footage and the upload is ${uploadSeconds.toFixed(1)}s. ` +
        'Cuts are compressed to fit, so each beat shows less than it asks for.',
    );
  }

  // Scaled rather than truncated: a 20s upload against a 30s script gives
  // every beat two thirds of its time instead of leaving the last two with
  // nothing, which is what a naive running offset does.
  const scale = uploadSeconds < wanted ? uploadSeconds / wanted : 1;
  let at = 0;

  const shots = post.shots.map((s) => {
    if (s.source.kind !== 'solid') return s;
    const span = s.seconds * scale;
    const from = at;
    at += span;
    return {
      ...s,
      source: { kind: 'clip' as const, path: uploadPath, from: Number(from.toFixed(2)), to: Number((from + span).toFixed(2)) },
    };
  });

  const spare = uploadSeconds - at;
  if (spare > uploadSeconds * 0.4) {
    warnings.push(
      `${spare.toFixed(0)}s of the upload is unused. The script may be shorter than what was filmed.`,
    );
  }

  return { shots, warnings };
}
