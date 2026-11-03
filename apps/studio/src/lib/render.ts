import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// ffmpeg-static's types declare the module shape rather than its default
// export, so the import is widened here once instead of at every use.
import ffmpegStatic from 'ffmpeg-static';
const ffmpegPath = ffmpegStatic as unknown as string | null;
import { Theme } from '../domain/workspace.js';
import type { Post, Shot } from './store.js';
import {
  FRAME_FPS,
  FRAME_H,
  FRAME_W,
  composeFrame,
  type FrameSpec,
  type MediaLayer,
  type SourceSize,
} from './compose.js';
import {
  cropScale,
  escFontPath,
  escText,
  mediaLayer,
  overlayFilters,
  photoZoomChain,
} from './filtergraph.js';

/**
 * Shots to a 9:16 reel.
 *
 * ── Why ffmpeg and not a video model ─────────────────────────────────
 *
 * This renders in seconds on any machine, costs nothing, and shows the
 * actual product. A generated clip takes 10 to 20 minutes on the hardware
 * this runs on, needs more system RAM than the machine has free, and shows
 * something that looks like software rather than the software.
 *
 * ── Why this file no longer computes any geometry ────────────────────
 *
 * It used to. `scale=...:force_original_aspect_ratio=increase`, `crop=W:H`,
 * `y=h-th-N`, `box=1:boxborderw=28` -- every one of those asks ffmpeg to
 * work out a number, and every one of those numbers is invisible to the
 * browser preview that has to agree with this. So the geometry moved to
 * `compose.ts`, which both read, and this file now only translates.
 *
 * The export remains the deliverable and the preview is allowed to be
 * approximate about frame timing and filtering. It is not allowed to be
 * approximate about where things are.
 */

const FPS = FRAME_FPS;
/**
 * The house style, used when a workspace does not state its own.
 *
 * Parsed through the schema rather than written out here, so there is one
 * definition of what a theme is and a default can never drift from it.
 */
const HOUSE: Theme = Theme.parse({});

const ffmpeg = (): string => {
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static did not resolve a binary for this platform.');
  }
  return ffmpegPath;
};

const run = (args: string[], label: string): void => {
  const r = spawnSync(ffmpeg(), args, { encoding: 'utf8' });
  if (r.status !== 0) {
    // ffmpeg's real complaint is in the last few lines of stderr; the rest
    // is banner. Surfacing the tail turns "it failed" into something fixable.
    const tail = (r.stderr ?? '').trimEnd().split('\n').slice(-6).join('\n');
    throw new Error(`ffmpeg failed on ${label}:\n${tail}`);
  }
};

/**
 * How big a source actually is.
 *
 * The geometry solver needs real dimensions -- it computes crops rather
 * than delegating them -- so they have to be measured instead of assumed.
 * ffprobe is not shipped by `ffmpeg-static`, but `ffmpeg -i` prints the
 * stream line to stderr and exits non-zero for want of an output, which is
 * a perfectly good probe as long as the exit code is deliberately ignored.
 *
 * Returns null rather than throwing: a shot whose source cannot be measured
 * degrades to a card, which is a visible but recoverable outcome.
 */
export function probeSize(path: string): SourceSize | null {
  const r = spawnSync(ffmpeg(), ['-hide_banner', '-i', path], { encoding: 'utf8' });
  const text = `${r.stderr ?? ''}`;
  // Anchored on the Video stream line so that a display aspect ratio or a
  // thumbnail stream cannot be read as the frame size.
  const m = /Video:[^\n]*?,\s*(\d{2,5})x(\d{2,5})/.exec(text);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? { w, h } : null;
}

/**
 * Why every shot carries an audio track.
 *
 * The concat demuxer copies streams; it does not invent them. One shot with
 * audio and the next without produces a file whose audio stops partway
 * through, or fails outright depending on the player. Since a creator's own
 * footage is the whole point of the clip kind, silence is synthesised for
 * everything else rather than stripping the one track that matters.
 */
const SILENT_IN = ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100'];
const AUDIO_OUT = ['-c:a', 'aac', '-b:a', '96k', '-ar', '44100', '-ac', '2', '-shortest'];
const VIDEO_OUT = [
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
];

const missing = (index: number, path: string): never => {
  throw new Error(
    `Shot ${index} wants assets/${path}, which does not exist.\n` +
      'Put the file there, or make the shot a title card.',
  );
};

/**
 * One shot as a clip with a track.
 *
 * Each shot is rendered on its own and concatenated, rather than built as
 * one filtergraph: a six-shot graph is unreadable, and when it breaks there
 * is no way to tell which shot broke it.
 */
function renderShot(
  shot: Shot,
  index: number,
  dir: string,
  assetsDir: string,
  fontFile: string | null,
  theme: Theme,
): string {
  const out = join(dir, `shot-${String(index).padStart(2, '0')}.mp4`);
  const dur = Math.max(1, Math.min(8, shot.seconds || 3));

  const hasPath = shot.source.kind !== 'solid';
  const srcPath = hasPath ? join(assetsDir, shot.source.path) : null;
  if (srcPath && !existsSync(srcPath)) missing(index, (shot.source as { path: string }).path);
  const size = srcPath ? probeSize(srcPath) : null;

  // The single source of truth for where everything sits. Asked for the
  // first instant of the shot; only a photograph changes over its length,
  // and that one case is handled by an expression below.
  const spec: FrameSpec = composeFrame({
    shot,
    index,
    t: 0,
    seconds: dur,
    theme,
    source: size,
  });
  const overlays = overlayFilters(spec.layers, fontFile);
  const media = mediaLayer(spec) as MediaLayer | undefined;

  if (shot.source.kind === 'clip' && media && srcPath) {
    const from = Math.max(0, shot.source.from);
    const span = Math.max(0.5, shot.source.to - from);
    run(
      [
        // -ss BEFORE -i seeks by keyframe and is near-instant; after -i it
        // decodes everything up to the point. On a ten-minute upload cut
        // into six beats that is the difference between seconds and minutes.
        '-y', '-ss', String(from), '-t', String(span), '-i', srcPath,
        '-filter_complex',
        `[0:v]${[
          ...cropScale(media.src, media.dst),
          'format=yuv420p',
          ...overlays,
        ].join(',')}[v]`,
        '-map', '[v]', '-map', '0:a?',
        '-r', String(FPS), ...VIDEO_OUT, ...AUDIO_OUT, out,
      ],
      `shot ${index} (clip ${shot.source.path} ${from}s-${shot.source.to}s)`,
    );
    return out;
  }

  if (shot.source.kind === 'photo' && size && srcPath) {
    const frames = Math.round(dur * FPS);
    run(
      [
        // -framerate on the INPUT, not just -r on the output. An image
        // input defaults to 25fps, and a 30fps output then runs short by a
        // sixth -- which exits zero and looks like a slightly quick cut.
        '-y', '-loop', '1', '-framerate', String(FPS), '-t', String(dur), '-i', srcPath,
        ...SILENT_IN,
        '-filter_complex',
        `[0:v]${[
          // A push, expressed in t. See photoZoomChain: crop cannot vary
          // its own size per frame, so the zoom lives in a scale with
          // eval=frame between two constant-size crops.
          ...photoZoomChain(size, dur, index),
          'format=yuv420p',
          ...overlays,
        ].join(',')}[v]`,
        '-map', '[v]', '-map', '1:a', '-frames:v', String(frames),
        '-r', String(FPS), ...VIDEO_OUT, ...AUDIO_OUT, out,
      ],
      `shot ${index} (photo ${shot.source.path})`,
    );
    return out;
  }

  if (shot.source.kind === 'asset' && media && srcPath) {
    run(
      [
        '-y',
        '-f', 'lavfi', '-t', String(dur),
        '-i', `color=c=${theme.ground}:s=${FRAME_W}x${FRAME_H}:r=${FPS}`,
        '-loop', '1', '-framerate', String(FPS), '-t', String(dur), '-i', srcPath,
        ...SILENT_IN,
        '-filter_complex',
        [
          // Fitted inside at an explicit size, placed at an explicit point.
          // The point of the shot is the UI in it, so nothing is cropped.
          `[1:v]scale=${media.dst.w}:${media.dst.h}[fg]`,
          `[0:v][fg]overlay=${media.dst.x}:${media.dst.y}[bg]`,
          `[bg]${['format=yuv420p', ...overlays].join(',')}[v]`,
        ].join(';'),
        '-map', '[v]', '-map', '2:a', '-r', String(FPS), ...VIDEO_OUT, ...AUDIO_OUT, out,
      ],
      `shot ${index} (asset ${shot.source.path})`,
    );
    return out;
  }

  // A plain card, and the fallback for a source that could not be measured.
  run(
    [
      '-y', '-f', 'lavfi', '-t', String(dur),
      '-i', `color=c=${theme.ground}:s=${FRAME_W}x${FRAME_H}:r=${FPS}`,
      ...SILENT_IN,
      '-vf', ['format=yuv420p', ...overlays].join(','),
      '-map', '0:v', '-map', '1:a',
      '-r', String(FPS), ...VIDEO_OUT, ...AUDIO_OUT, out,
    ],
    `shot ${index} (card)`,
  );
  return out;
}

/**
 * A font that can draw this caption's script.
 *
 * Devanagari is why this exists. ffmpeg's default font has no Devanagari
 * glyphs, so a Marathi or Hindi caption renders as nothing at all --
 * silently, with a zero exit code. The same class of bug cost this repo a
 * fortnight of a live site being set in the wrong font.
 *
 * A workspace supplies its own faces in `fonts/`, because the platform
 * cannot know which scripts a tenant writes in. The filename carries the
 * language tag: `fonts/mr.ttf`, `fonts/hi.ttf`, `fonts/default.ttf`.
 */
function fontFor(language: string, workspaceDir: string): string | null {
  const dir = join(workspaceDir, 'fonts');
  const candidates = [
    join(dir, `${language}.ttf`),
    // The base tag, so `mr-IN` finds `mr.ttf`.
    join(dir, `${language.split('-')[0]}.ttf`),
    join(dir, 'default.ttf'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

/**
 * A face shipped with the operating system.
 *
 * Only ever used for Latin captions with no workspace font: ffmpeg's
 * `font=sans` resolves to a monospace face on Windows, and a reel set in
 * Courier reads as a terminal rather than as something a person made.
 * Deliberately NOT consulted for other scripts -- Arial has no Devanagari,
 * so letting it stand in would turn a loud warning into a silent tofu row.
 */
const SYSTEM_FACES = [
  'C:/Windows/Fonts/arialbd.ttf',
  'C:/Windows/Fonts/arial.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
];

function systemFace(): string | null {
  for (const f of SYSTEM_FACES) if (existsSync(f)) return f;
  return null;
}

export interface RenderResult {
  path: string;
  seconds: number;
  warnings: string[];
}

export function renderPost(
  post: Post,
  assetsDir: string,
  outDir: string,
  theme: Theme = HOUSE,
): RenderResult {
  const warnings: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'studio-'));
  try {
    const workspaceFont = fontFor(post.language, join(assetsDir, '..'));
    // A LETTER outside Latin is what needs a supplied face. The first
    // version tested for any codepoint above U+024F, which also flagged an
    // arrow or a "not equal" sign -- punctuation every system face has --
    // and would have dropped a perfectly renderable caption to tofu.
    const needsFont = [...post.shots.map((x) => x.caption).join('')].some(
      (ch) => /\p{L}/u.test(ch) && !/\p{Script=Latin}/u.test(ch),
    );
    if (!workspaceFont && needsFont) {
      warnings.push(
        `The captions use a script ffmpeg's default font cannot draw, and this ` +
          `workspace has no fonts/${post.language}.ttf. They will render BLANK, ` +
          'not fail. Put a .ttf there.',
      );
    }

    // Latin falls back to a system face; anything else does not, so the
    // warning above stays the only outcome for a missing script font.
    const font = workspaceFont ?? (needsFont ? null : systemFace());

    const clips = post.shots.map((s, i) => renderShot(s, i, dir, assetsDir, font, theme));

    // concat demuxer rather than the filter: every clip was produced by
    // this file with identical codec settings, so there is nothing to
    // re-encode, and re-encoding six times is six chances to lose quality.
    const list = join(dir, 'list.txt');
    writeFileSync(
      list,
      clips.map((c) => `file '${c.replace(/\\/g, '/')}'`).join('\n'),
      'utf8',
    );

    const out = join(outDir, `${post.id}.mp4`);
    run(
      [
        '-y', '-f', 'concat', '-safe', '0', '-i', list,
        // Both streams copied. Every shot was written by this file with the
        // same codecs, and a creator's voice must survive the join -- an
        // re-encode here would be the one place a reel quietly loses audio.
        '-c', 'copy', '-movflags', '+faststart', out,
      ],
      'concat',
    );

    const seconds = post.shots.reduce((n, s) => n + Math.max(1, Math.min(8, s.seconds || 3)), 0);
    return { path: out, seconds, warnings };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** For `doctor`: is there a usable ffmpeg at all? */
export function ffmpegVersion(): string | null {
  try {
    const r = spawnSync(ffmpeg(), ['-version'], { encoding: 'utf8' });
    return r.status === 0 ? (r.stdout.split('\n')[0] ?? null) : null;
  } catch {
    return null;
  }
}

/** Re-exported so callers do not reach past this module for the frame size. */
export { FRAME_W, FRAME_H, FPS as FRAME_FPS, escText };
