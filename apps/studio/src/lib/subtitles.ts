/**
 * Word timings to burnt-in captions.
 *
 * ── What this module is for ──────────────────────────────────────────
 *
 * Speech recognition returns words with millisecond timings. Those are not
 * captions. Turning them into captions is the part that decides whether a
 * reel is watchable, and it is almost entirely a question of *grouping*:
 * how many words go on screen together, for how long, and where the breaks
 * fall.
 *
 * Get it wrong in the obvious ways and the result is unwatchable in ways
 * that are hard to name afterwards -- captions that flash too briefly to
 * read, a line that changes mid-phrase, a single orphaned word sitting on
 * screen, or text that runs ahead of the voice.
 *
 * ── Where the numbers come from, and where they disagree ─────────────
 *
 * Broadcast standards exist and are worth following, with one honest
 * caveat: they do not agree with each other.
 *
 *   - Netflix: minimum 5/6 of a second, maximum 7 seconds, 2-frame gap.
 *     These three are consistently reported. Its reading-speed cap is NOT:
 *     sources give both 17 and 20 characters per second for adult English,
 *     and Netflix's own two guideline pages have been reported to give the
 *     minimum as 5/6s on one and 4/5s on the other.
 *   - BBC: measures words per minute instead, targeting 160-180 WPM, which
 *     works out around 15 CPS, with a minimum tied to word count at about
 *     0.3s per word.
 *   - Practitioner guides range from 14 to 21 CPS.
 *
 * So `SUBTITLE_STYLE` below uses **17 CPS**: the lower of the two figures
 * reported for Netflix, and close to the BBC's effective rate. Choosing the
 * conservative end is right here because a caption that is too slow costs
 * nothing and one that is too fast is unreadable. Recorded rather than
 * buried so that whoever changes it knows it was a choice between
 * conflicting sources, not a transcription of one.
 *
 * ── Why there are two styles ─────────────────────────────────────────
 *
 * A film subtitle and a reel caption are different objects. A subtitle sits
 * quietly at the bottom of a wide frame and is read by someone who cannot
 * hear the audio; two lines of 42 characters is right. A reel caption is
 * the *performance* -- it is read by someone scrolling with the sound on,
 * it is large, and it changes every few words to hold attention. Applying
 * film rules to a reel produces a wall of text nobody watches.
 *
 * Neither style is "correct". They are for different jobs, so both exist.
 *
 * Pure: no fs, no network, no ffmpeg. Which is the point -- caption timing
 * is exactly the kind of logic that should be provable in a terminal.
 */

/** One recognised word. Milliseconds, because that is what ASR returns. */
export interface Word {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  /** 0..1. Surfaced rather than hidden: a low score is worth showing. */
  readonly confidence: number;
}

/** A group of words on screen together. */
export interface Cue {
  readonly startMs: number;
  readonly endMs: number;
  /** Already wrapped. The renderer never re-breaks these. */
  readonly lines: readonly string[];
  readonly words: readonly Word[];
}

export interface CueStyle {
  readonly maxCharsPerLine: number;
  readonly maxLines: number;
  /** A hard cap on words per cue, which is what makes a reel feel fast. */
  readonly maxWords: number;
  readonly minDurationMs: number;
  readonly maxDurationMs: number;
  /** Blank frames between cues, so two do not appear to be one. */
  readonly minGapMs: number;
  /** Characters per second. The reading-speed ceiling. */
  readonly maxCps: number;
  /** A silence at least this long is treated as a natural break. */
  readonly pauseSplitMs: number;
}

/**
 * The reel style: short bursts, timed to the voice.
 *
 * Three or four words at a time is what reads as deliberate on a phone.
 * `maxCps` is effectively unreachable at this word count, and is kept only
 * so the checker has something to measure.
 */
export const REEL_STYLE: CueStyle = {
  maxCharsPerLine: 20,
  maxLines: 2,
  maxWords: 4,
  // Below about a third of a second a caption reads as a flicker. Shorter
  // than Netflix's 5/6s floor on purpose: at four words, holding every cue
  // for 833ms would put the text behind the voice within two sentences.
  minDurationMs: 320,
  maxDurationMs: 2500,
  minGapMs: 40,
  maxCps: 30,
  pauseSplitMs: 350,
};

/** The broadcast style, for a long-form cut or an export to an SRT. */
export const SUBTITLE_STYLE: CueStyle = {
  maxCharsPerLine: 42,
  maxLines: 2,
  maxWords: 14,
  // Netflix's 5/6 of a second, in milliseconds.
  minDurationMs: 833,
  maxDurationMs: 7000,
  // Two frames at 30fps, which is the rule most consistently reported.
  minGapMs: 67,
  maxCps: 17,
  pauseSplitMs: 700,
};

/** Punctuation after which a break is natural rather than forced. */
const SENTENCE_END = /[.!?…।]$/;
const CLAUSE_END = /[,;:—]$/;

const charsOf = (words: readonly Word[]): number =>
  words.reduce((n, w) => n + w.text.length, 0) + Math.max(0, words.length - 1);

/**
 * Break words into groups, before any timing is decided.
 *
 * The order of the checks is the whole design. A break at a sentence end is
 * free; a break at a clause is nearly free; a break forced by running out
 * of room is the one that reads badly, so it is last.
 */
function group(words: readonly Word[], style: CueStyle): Word[][] {
  const out: Word[][] = [];
  let current: Word[] = [];

  const flush = () => {
    if (current.length) out.push(current);
    current = [];
  };

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    const prev = current[current.length - 1];

    // A real silence is where a human would break, so break there first --
    // before any limit is reached, because a cue that spans a pause looks
    // like it is lagging the voice.
    if (prev && word.startMs - prev.endMs >= style.pauseSplitMs) flush();

    const next = [...current, word];
    if (
      current.length > 0 &&
      (next.length > style.maxWords ||
        charsOf(next) > style.maxCharsPerLine * style.maxLines)
    ) {
      flush();
      current = [word];
    } else {
      current = next;
    }

    // Break AFTER a sentence ends rather than carrying the next sentence's
    // first words into this cue.
    if (SENTENCE_END.test(word.text)) {
      flush();
      continue;
    }
    // A clause break is only worth taking if the cue is already most of
    // the way full; taking every comma produces two-word cues.
    if (
      CLAUSE_END.test(word.text) &&
      current.length >= Math.max(2, style.maxWords - 1)
    ) {
      flush();
    }
  }
  flush();
  return out;
}

/**
 * A single orphaned word is worse than an uneven pair of cues.
 *
 * One short word alone on screen reads as a mistake, and it happens
 * constantly: a four-word cap plus a five-word sentence leaves exactly one
 * word behind, every time.
 *
 * Two ways out, tried in order:
 *
 *   1. Merge it back, when the previous cue has room.
 *   2. When the previous cue is already at the word cap, **move its last
 *      word forward** into the orphan instead. Four-plus-one becomes
 *      three-plus-two, the cap is respected, and the orphan is gone.
 *
 * The second is why this function is not two lines. Simply allowing the cap
 * to be exceeded would have been easier and is the wrong trade: the cap is
 * what makes a reel caption feel paced, and an occasional three-word cue
 * costs nothing.
 */
function unorphan(groups: Word[][], style: CueStyle): Word[][] {
  const out: Word[][] = [];
  const fits = (ws: Word[]) => charsOf(ws) <= style.maxCharsPerLine * style.maxLines;

  for (const g of groups) {
    const prev = out[out.length - 1];
    const isOrphan = g.length === 1 && g[0]!.text.length <= 4;
    // Never touch a break that follows a real silence: the viewer can hear
    // why it is there.
    const acrossPause =
      prev !== undefined && g[0]!.startMs - prev[prev.length - 1]!.endMs >= style.pauseSplitMs;

    if (!isOrphan || !prev || acrossPause) {
      out.push(g);
      continue;
    }

    const merged = [...prev, ...g];
    if (merged.length <= style.maxWords && fits(merged)) {
      out[out.length - 1] = merged;
      continue;
    }
    // Give the orphan a companion from the cue before it, as long as that
    // cue keeps at least two words of its own.
    if (prev.length >= 3) {
      const moved = prev[prev.length - 1]!;
      const shortened = prev.slice(0, -1);
      const grown = [moved, ...g];
      if (fits(grown)) {
        out[out.length - 1] = shortened;
        out.push(grown);
        continue;
      }
    }
    out.push(g);
  }
  return out;
}

/**
 * Wrap a cue's words into lines.
 *
 * Balanced rather than greedy: a greedy fill produces a full first line and
 * one word on the second, which looks like a mistake at caption size. With
 * two lines this means aiming for half the characters on each.
 */
export function layoutLines(words: readonly Word[], style: CueStyle): string[] {
  const text = words.map((w) => w.text).join(' ');
  if (text.length <= style.maxCharsPerLine) return [text];

  const target = Math.ceil(charsOf(words) / Math.min(style.maxLines, 2));
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word.text}` : word.text;
    const full = candidate.length > style.maxCharsPerLine;
    const pastTarget = line.length >= target && lines.length < style.maxLines - 1;
    if (line && (full || pastTarget)) {
      lines.push(line);
      line = word.text;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  // A cue that still does not fit is kept whole rather than truncated.
  // Losing a creator's words silently is never the right failure.
  return lines.slice(0, Math.max(1, style.maxLines)).concat(
    lines.length > style.maxLines ? [lines.slice(style.maxLines).join(' ')] : [],
  );
}

/**
 * Words to cues.
 *
 * Timing happens after grouping, and in one pass forward, so a cue can be
 * stretched into the silence that follows it but can never be stretched
 * over the cue after it.
 */
export function buildCues(words: readonly Word[], style: CueStyle = REEL_STYLE): Cue[] {
  const usable = words.filter((w) => w.text.trim().length > 0);
  if (usable.length === 0) return [];

  const groups = unorphan(group(usable, style), style);
  const cues: Cue[] = [];

  for (let i = 0; i < groups.length; i += 1) {
    const g = groups[i]!;
    const first = g[0]!;
    const last = g[g.length - 1]!;
    const nextStart = groups[i + 1]?.[0]?.startMs ?? Infinity;

    const startMs = first.startMs;
    // How long the words themselves occupy, before any adjustment.
    let endMs = Math.max(last.endMs, startMs + 1);

    // Reading speed and the minimum both want a longer cue. Take whichever
    // is longer, then give back whatever the next cue needs.
    const chars = charsOf(g);
    const neededForReading = (chars / style.maxCps) * 1000;
    const wanted = Math.max(style.minDurationMs, neededForReading);
    if (endMs - startMs < wanted) endMs = startMs + wanted;

    // Never overlap, and always leave a visible gap.
    const ceiling = nextStart === Infinity ? Infinity : nextStart - style.minGapMs;
    if (endMs > ceiling) endMs = Math.max(startMs + 1, ceiling);

    // The maximum is a hard cap; a cue held for nine seconds reads as a
    // frozen video.
    if (endMs - startMs > style.maxDurationMs) endMs = startMs + style.maxDurationMs;

    cues.push({ startMs, endMs, lines: layoutLines(g, style), words: g });
  }
  return cues;
}

/** Which cue is on screen at an instant, if any. */
export function cueAt(cues: readonly Cue[], ms: number): Cue | null {
  // Linear is correct here: a reel has tens of cues, and a binary search
  // would be the kind of optimisation that introduces an off-by-one for
  // no measurable gain.
  for (const c of cues) {
    if (ms >= c.startMs && ms < c.endMs) return c;
  }
  return null;
}

/** The caption text for an instant, ready for the geometry solver. */
export const captionAt = (cues: readonly Cue[], ms: number): string =>
  cueAt(cues, ms)?.lines.join('\n') ?? '';

// ---------------------------------------------------------------------------
// The checker.

export interface CueProblem {
  readonly index: number;
  readonly what: string;
  /** True when it will be visible to a viewer rather than merely untidy. */
  readonly severe: boolean;
}

/**
 * Check cues against the style they were built for.
 *
 * Exists because the builder can be forced into a compromise -- a cue
 * crowded by its neighbour cannot be given its full minimum duration -- and
 * a compromise that nothing reports is a defect nobody finds. This is the
 * same role a caption linter plays against broadcast specs.
 */
export function cueProblems(cues: readonly Cue[], style: CueStyle): CueProblem[] {
  const out: CueProblem[] = [];
  cues.forEach((cue, index) => {
    const duration = cue.endMs - cue.startMs;
    const chars = cue.lines.join(' ').length;
    const cps = duration > 0 ? chars / (duration / 1000) : Infinity;

    if (duration < style.minDurationMs) {
      out.push({
        index,
        what: `on screen ${Math.round(duration)}ms, under the ${style.minDurationMs}ms floor`,
        severe: duration < style.minDurationMs * 0.6,
      });
    }
    if (duration > style.maxDurationMs + 1) {
      out.push({ index, what: `held ${Math.round(duration)}ms`, severe: false });
    }
    if (cps > style.maxCps * 1.05) {
      out.push({
        index,
        what: `${cps.toFixed(1)} characters per second, over the ${style.maxCps} limit`,
        severe: cps > style.maxCps * 1.4,
      });
    }
    if (cue.lines.length > style.maxLines) {
      out.push({ index, what: `${cue.lines.length} lines`, severe: true });
    }
    for (const line of cue.lines) {
      if (line.length > style.maxCharsPerLine) {
        out.push({
          index,
          what: `a line of ${line.length} characters, over ${style.maxCharsPerLine}`,
          severe: line.length > style.maxCharsPerLine * 1.3,
        });
      }
    }
    const next = cues[index + 1];
    if (next) {
      if (next.startMs < cue.endMs) {
        out.push({ index, what: `overlaps the next cue`, severe: true });
      } else if (next.startMs - cue.endMs < style.minGapMs - 1) {
        out.push({ index, what: `gap under ${style.minGapMs}ms`, severe: false });
      }
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Interchange.

const stamp = (ms: number, comma: boolean): string => {
  const clamped = Math.max(0, Math.round(ms));
  const h = Math.floor(clamped / 3_600_000);
  const m = Math.floor((clamped % 3_600_000) / 60_000);
  const s = Math.floor((clamped % 60_000) / 1000);
  const milli = clamped % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}${comma ? ',' : '.'}${p(milli, 3)}`;
};

/**
 * SubRip, which every player and every editor reads.
 *
 * Offered alongside burnt-in captions rather than instead of them: burnt-in
 * is what a social platform needs, and a sidecar file is what a creator
 * needs to hand the same cut to someone else.
 */
export function toSRT(cues: readonly Cue[]): string {
  return (
    cues
      .map(
        (c, i) =>
          `${i + 1}\n${stamp(c.startMs, true)} --> ${stamp(c.endMs, true)}\n${c.lines.join('\n')}`,
      )
      .join('\n\n') + (cues.length ? '\n' : '')
  );
}

/** WebVTT, for a browser `<track>`. */
export function toVTT(cues: readonly Cue[]): string {
  const body = cues
    .map((c) => `${stamp(c.startMs, false)} --> ${stamp(c.endMs, false)}\n${c.lines.join('\n')}`)
    .join('\n\n');
  return `WEBVTT\n\n${body}${cues.length ? '\n' : ''}`;
}

/**
 * Cues shifted and clipped to a shot's own window.
 *
 * The editor cuts and reorders shots, so a cue's position on the finished
 * reel is not where it sat in the original recording. `sourceIn` is where
 * the shot starts inside the footage and `start` is where it lands on the
 * timeline; a cue is kept only if it overlaps the part actually used, and
 * is clipped at both ends so it cannot bleed past a cut.
 *
 * This is the step that makes auto-captions survive editing. Without it,
 * trimming the first two seconds off a clip leaves every caption two
 * seconds early for the rest of the reel.
 */
export function cuesForClip(
  cues: readonly Cue[],
  sourceInMs: number,
  durationMs: number,
  timelineStartMs: number,
  style: CueStyle = REEL_STYLE,
): Cue[] {
  const sourceEnd = sourceInMs + durationMs;
  const out: Cue[] = [];

  for (const c of cues) {
    if (c.endMs <= sourceInMs || c.startMs >= sourceEnd) continue;

    // A cue straddling the cut must not keep showing the words that were
    // cut away. Clipping only its timing would leave the viewer reading
    // text for speech that is no longer in the reel -- which looks like
    // the captions are out of sync, and is the subtler half of this bug.
    // So the words are filtered to those still audible, and the lines are
    // laid out again from what survives.
    const kept = c.words.filter((w) => w.endMs > sourceInMs && w.startMs < sourceEnd);
    // A cue with no word timings at all (hand-written, or imported from an
    // SRT) cannot be filtered, so its text is taken as given.
    const words = c.words.length === 0 ? c.words : kept;
    if (c.words.length > 0 && kept.length === 0) continue;

    const startMs = Math.max(c.startMs, sourceInMs) - sourceInMs + timelineStartMs;
    const endMs = Math.min(c.endMs, sourceEnd) - sourceInMs + timelineStartMs;
    if (endMs - startMs < 1) continue;

    const lines =
      words.length > 0 && words.length !== c.words.length ? layoutLines(words, style) : c.lines;
    out.push({ startMs, endMs, lines, words });
  }
  return out;
}
