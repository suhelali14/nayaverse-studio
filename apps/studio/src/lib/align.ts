/**
 * Forced alignment: the script's words, with the audio's timing.
 *
 * ── The problem, and why it is not "just run a recogniser" ──────────────
 *
 * A faceless reel is narrated from a script the creator wrote. So the text
 * is already known exactly -- spelling, punctuation, brand names, prices,
 * the lot. What is *not* known is when each word is spoken, and captions
 * need that to the frame.
 *
 * A speech recogniser supplies timing. It does not supply the text. Run one
 * over a narration of this repo's own pitch and it returns things like:
 *
 *     script:  "Nayaverse costs ₹999 a month -- no watermark."
 *     heard:    naya verse costs nine hundred ninety nine rupees a
 *               month no water mark
 *
 * Every product that captions from raw recogniser output ships that second
 * line. The brand is two words, the price is five, the dash is gone. It is
 * not a transcription error so much as a category error: the recogniser was
 * asked a question nobody needed answered.
 *
 * The fix is the standard one in the open pipelines surveyed for this
 * module: transcribe the narration, then **align the recogniser's words
 * back onto the script**, and keep the script's spelling with the
 * recogniser's timing. Everything displayed comes from the script;
 * everything temporal comes from the audio.
 *
 * ── How the alignment works ─────────────────────────────────────────────
 *
 * Needleman-Wunsch global alignment over *normalised* tokens. Normalisation
 * is for comparison only and never reaches the output: casing and
 * punctuation are stripped to decide whether two tokens are the same word,
 * and the script's own token is what gets emitted.
 *
 * The interesting part is what happens where the two sides genuinely do not
 * correspond one-to-one, which on a pricing script is most of the
 * interesting words. "₹999" against "nine hundred ninety nine rupees" has
 * no sensible token pairing at all. Rather than special-casing numbers,
 * currencies and acronyms -- a verbaliser per language, and this product
 * ships twelve -- unmatched runs on both sides are paired up positionally
 * and the run's total time is split across the script's tokens by character
 * length. One rule, no language data, and it handles prices, dates,
 * acronyms, hashtags and brand names identically.
 *
 * ── What this module guarantees ─────────────────────────────────────────
 *
 *   1. The emitted text, joined back together, is **exactly** the script.
 *      Never a recogniser's spelling. This is the property the module
 *      exists for, and `test/align.test.mts` asserts it on every case.
 *   2. Timings are monotonic and non-overlapping, because `buildCues` in
 *      `subtitles.ts` groups on gaps and would read an overlap as a
 *      zero-length pause.
 *   3. A word the recogniser never heard is still emitted, interpolated
 *      between its neighbours and marked with low confidence -- dropping
 *      it would silently edit the creator's script.
 *   4. `AlignmentReport.matchRate` says how much of the script was actually
 *      found in the audio, so a caller can refuse a bad alignment instead
 *      of captioning confident nonsense. Alignment cannot tell "the
 *      narration is of a different script" from "the recogniser did
 *      badly", and it must not pretend to.
 */

/** One word as a recogniser reported it. Mirrors `subtitles.ts`'s `Word`. */
export interface HeardWord {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly confidence: number;
}

/** One word of the script, timed. The shape `buildCues` consumes. */
export interface AlignedWord {
  /** The script's own token, verbatim, punctuation included. */
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly confidence: number;
  /** How this word got its timing. Surfaced for the report, and for debugging. */
  readonly source: "matched" | "distributed" | "interpolated";
}

export interface AlignmentReport {
  readonly scriptWords: number;
  readonly heardWords: number;
  /** Script tokens matched to a recogniser token outright, over the total. */
  readonly matchRate: number;
  /** Script tokens that got time from an unmatched run, split by length. */
  readonly distributed: number;
  /** Script tokens the audio has no time for at all. */
  readonly interpolated: number;
}

export interface Alignment {
  readonly words: readonly AlignedWord[];
  readonly report: AlignmentReport;
}

/**
 * Below this, treat the alignment as a failure rather than a result.
 *
 * Chosen to sit well clear of ordinary recogniser noise. A clean narration
 * of its own script matches above 0.9 even with the price and the brand
 * name mangled; a narration of a *different* script lands near zero. The
 * band between is where a caller should be asking a human, which is what
 * refusing lets them do.
 */
export const MIN_MATCH_RATE = 0.55;

/**
 * The largest alignment this does properly.
 *
 * The matrix is O(script x heard). 400x400 is 160k cells and runs in
 * microseconds; a feature-length narration would not. Past this the
 * fallback is honest rather than clever -- see `distributeEvenly`.
 */
const MAX_MATRIX_CELLS = 4_000_000;

// Scores. Mismatch is worse than two gaps so the matrix never pairs two
// unrelated words just to avoid a gap; a genuine one-for-one substitution
// comes out as a one-token run on each side, which `distribute` then pairs
// positionally anyway -- same timing, without the false claim of a match.
const EXACT = 3;
const NEAR = 2;
const PREFIX = 1;
const MISMATCH = -3;
const GAP = -1;

// ---------------------------------------------------------------------------
// Tokens.

/**
 * Split on whitespace, keeping every token exactly as written.
 *
 * Punctuation stays attached, because a caption reads "Wait -- there's
 * more" and not "Wait there s more". Normalisation for *comparison* happens
 * separately, in `normalise`.
 */
export function tokeniseScript(script: string): string[] {
  return script.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * The comparison form of a token.
 *
 * Lower-cased, with everything that is not part of a word removed, so
 * "Nayaverse," "nayaverse" and "NAYAVERSE" are one word, and "₹999" reduces
 * to "999".
 *
 * ── `\p{M}` is the whole ballgame, and it is easy to miss ───────────────
 *
 * The obvious class to keep is "letters and digits", `\p{L}\p{N}`. That is
 * wrong for every Indic script this product ships, because a Devanagari
 * vowel sign is not a letter -- it is a combining **mark**, `\p{M}`. Keep
 * only letters and digits and the matra is deleted:
 *
 *     घराजवळ  ->  घरजवळ      (the ा is gone: a different word)
 *     नन्றி    ->  நனற        (Tamil loses its virama and vowel sign)
 *
 * It does not merely mangle the comparison form. It makes distinct words
 * collide -- कर and कार both reduce to कर -- so the alignment matrix would
 * confidently pair the wrong words and caption the script in the wrong
 * order. A bug found only by comparing codepoints, which is the standing
 * rule in this repo for non-ASCII: never trust how it looks in a terminal.
 *
 * NFC first, because the same word typed on two keyboards, or returned by a
 * recogniser rather than typed at all, can arrive as different codepoint
 * sequences that must still compare equal.
 */
export function normalise(token: string): string {
  return token
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]/gu, "");
}

/** Levenshtein, capped: beyond `limit` the exact distance does not matter. */
function withinEditDistance(a: string, b: string, limit: number): boolean {
  if (Math.abs(a.length - b.length) > limit) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      row.push(v);
      if (v < best) best = v;
    }
    // Every path through this row already costs more than the limit.
    if (best > limit) return false;
    prev = row;
  }
  return prev[b.length]! <= limit;
}

/**
 * How alike two normalised tokens are.
 *
 * The near-match tier is what absorbs ordinary recogniser drift -- "momin"
 * for "mommin", "colour" for "color" -- without letting short words pair up
 * loosely. One edit inside a four-letter word is a different word far too
 * often ("ride"/"rude", "cat"/"cut"), so the tier starts at five.
 */
function similarity(s: string, h: string): number {
  if (s.length === 0 || h.length === 0) return MISMATCH;
  if (s === h) return EXACT;
  if (s.length >= 5 && h.length >= 5 && withinEditDistance(s, h, 1)) return NEAR;
  if (s.length >= 4 && h.length >= 4 && (s.startsWith(h) || h.startsWith(s))) return PREFIX;
  return MISMATCH;
}

// ---------------------------------------------------------------------------
// The matrix.

type Op =
  | { readonly kind: "match"; readonly s: number; readonly h: number }
  | { readonly kind: "script"; readonly s: number }
  | { readonly kind: "heard"; readonly h: number };

/**
 * Global alignment of the two token lists.
 *
 * Global rather than local: every script token must come out somewhere,
 * because every one of them is going on screen. A local alignment would be
 * free to drop the beginning and end of the script, which is precisely
 * where a hook and a call to action live.
 */
function align(script: readonly string[], heard: readonly string[]): Op[] {
  const n = script.length;
  const m = heard.length;

  // One row of scores plus a full traceback grid. The traceback has to be
  // kept whole -- it is the answer, not an intermediate.
  const score: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i += 1) score[i]![0] = i * GAP;
  for (let j = 1; j <= m; j += 1) score[0]![j] = j * GAP;

  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const diag = score[i - 1]![j - 1]! + similarity(script[i - 1]!, heard[j - 1]!);
      const up = score[i - 1]![j]! + GAP;
      const left = score[i]![j - 1]! + GAP;
      score[i]![j] = Math.max(diag, up, left);
    }
  }

  // Walk back from the corner. Recomputing the three candidates is cheaper
  // than having stored a direction per cell, and cannot disagree with the
  // forward pass the way a separate grid can.
  const ops: Op[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const sim = similarity(script[i - 1]!, heard[j - 1]!);
      if (score[i]![j] === score[i - 1]![j - 1]! + sim) {
        // A forced pairing of two unrelated words is not a match. Emitting
        // it as one gap each keeps `matchRate` honest and gives `distribute`
        // the chance to pair the run positionally.
        ops.push(
          sim > MISMATCH
            ? { kind: "match", s: i - 1, h: j - 1 }
            : { kind: "script", s: i - 1 },
        );
        if (sim <= MISMATCH) ops.push({ kind: "heard", h: j - 1 });
        i -= 1;
        j -= 1;
        continue;
      }
    }
    if (i > 0 && score[i]![j] === score[i - 1]![j]! + GAP) {
      ops.push({ kind: "script", s: i - 1 });
      i -= 1;
      continue;
    }
    ops.push({ kind: "heard", h: j - 1 });
    j -= 1;
  }
  return ops.reverse();
}

// ---------------------------------------------------------------------------
// Turning the alignment into timings.

/**
 * A stretch of script tokens and the heard tokens that cover them.
 *
 * A matched pair is a unit of one and one. An unmatched run on either side
 * accumulates into a unit of many and many -- which is where "₹999" meets
 * "nine hundred ninety nine rupees" and the two are paired by position
 * rather than by any claim about what the words mean.
 */
interface Unit {
  readonly script: number[];
  readonly heard: number[];
  readonly matched: boolean;
}

function toUnits(ops: readonly Op[]): Unit[] {
  const units: Unit[] = [];
  let pending: Unit | null = null;

  const flush = (): void => {
    if (pending && (pending.script.length > 0 || pending.heard.length > 0)) units.push(pending);
    pending = null;
  };

  for (const op of ops) {
    if (op.kind === "match") {
      flush();
      units.push({ script: [op.s], heard: [op.h], matched: true });
      continue;
    }
    pending ??= { script: [], heard: [], matched: false };
    if (op.kind === "script") pending.script.push(op.s);
    else pending.heard.push(op.h);
  }
  flush();
  return units;
}

/**
 * Even distribution across the whole narration.
 *
 * The fallback for an input too large to align and for a narration with no
 * usable recogniser output at all. It is deliberately crude: every word
 * gets a share of the clip proportional to its length, which is right on
 * average and wrong everywhere in particular. Each word is marked
 * `interpolated` and carries low confidence so that nothing downstream
 * mistakes this for alignment.
 */
function distributeEvenly(
  tokens: readonly string[],
  startMs: number,
  endMs: number,
): AlignedWord[] {
  const total = tokens.reduce((sum, t) => sum + Math.max(t.length, 1), 0);
  const span = Math.max(endMs - startMs, tokens.length);
  let at = startMs;
  return tokens.map((text) => {
    const share = (Math.max(text.length, 1) / total) * span;
    const word = {
      text,
      startMs: Math.round(at),
      endMs: Math.round(at + share),
      confidence: 0.1,
      source: "interpolated" as const,
    };
    at += share;
    return word;
  });
}

/**
 * Align a script to a recogniser's output.
 *
 * `heard` is expected in time order; it is sorted defensively, because a
 * provider that streams partial results can emit a correction out of order
 * and one swapped pair would invert a caption's timing.
 */
export function alignScript(script: string, heard: readonly HeardWord[]): Alignment {
  const tokens = tokeniseScript(script);
  if (tokens.length === 0) {
    return {
      words: [],
      report: {
        scriptWords: 0,
        heardWords: heard.length,
        matchRate: 0,
        distributed: 0,
        interpolated: 0,
      },
    };
  }

  const audible = [...heard]
    .filter((w) => w.text.trim().length > 0 && w.endMs > w.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  const emptyReport = (words: readonly AlignedWord[]): Alignment => ({
    words,
    report: {
      scriptWords: tokens.length,
      heardWords: audible.length,
      matchRate: 0,
      distributed: 0,
      interpolated: words.length,
    },
  });

  if (audible.length === 0) return emptyReport(distributeEvenly(tokens, 0, tokens.length * 400));

  const first = audible[0]!.startMs;
  const last = audible[audible.length - 1]!.endMs;

  if (tokens.length * audible.length > MAX_MATRIX_CELLS) {
    return emptyReport(distributeEvenly(tokens, first, last));
  }

  const ops = align(tokens.map(normalise), audible.map((w) => normalise(w.text)));
  const units = toUnits(ops);

  // Pass 1: give every unit a time span. A unit with no heard tokens has no
  // span of its own and is interpolated in pass 3.
  const slots: (AlignedWord | null)[] = new Array(tokens.length).fill(null);
  let matched = 0;
  let distributed = 0;
  let lastScript: number | null = null;

  for (const unit of units) {
    if (unit.heard.length === 0) {
      // Pass 3 handles these, but they still break the chain: a word with
      // no time of its own must not be extended over by the orphan rule.
      if (unit.script.length > 0) lastScript = null;
      continue;
    }
    const spanStart = Math.min(...unit.heard.map((h) => audible[h]!.startMs));
    const spanEnd = Math.max(...unit.heard.map((h) => audible[h]!.endMs));
    const confidence =
      unit.heard.reduce((sum, h) => sum + audible[h]!.confidence, 0) / unit.heard.length;

    if (unit.script.length === 0) {
      // The recogniser produced words the script does not contain. Nearly
      // always it split one written word into several spoken ones --
      // "Nayaverse" heard as "naya verse", "watermark" as "water mark" --
      // in which case the script's token matched the first piece and the
      // rest are the same word still being said.
      //
      // So the preceding word is held on screen across them instead of
      // vanishing partway through its own audio. Capped, because the other
      // cause is a flubbed take or a whole sentence the reader improvised,
      // and holding one caption over three seconds of unrelated speech
      // would be worse than the gap it replaces.
      const prev = lastScript === null ? null : slots[lastScript];
      if (prev) {
        const HOLD_CAP_MS = 400;
        slots[lastScript!] = {
          ...prev,
          endMs: Math.min(Math.max(prev.endMs, spanEnd), prev.endMs + HOLD_CAP_MS),
        };
      }
      continue;
    }

    if (unit.matched) matched += 1;
    else distributed += unit.script.length;

    // Split by character length. A long word takes longer to say than a
    // short one, which is a better approximation than an equal share and
    // costs nothing. Only reached with more than one token when the run was
    // unmatched on both sides.
    const total = unit.script.reduce((sum, s) => sum + Math.max(tokens[s]!.length, 1), 0);
    let at = spanStart;
    for (const s of unit.script) {
      const share = (Math.max(tokens[s]!.length, 1) / total) * (spanEnd - spanStart);
      slots[s] = {
        text: tokens[s]!,
        startMs: Math.round(at),
        endMs: Math.round(at + share),
        confidence: unit.matched ? confidence : Math.min(confidence, 0.6),
        source: unit.matched ? "matched" : "distributed",
      };
      at += share;
    }
    lastScript = unit.script[unit.script.length - 1]!;
  }

  // Pass 2 and 3: fill the holes. A run of untimed words is spread across
  // the silence between the timed words on either side of it -- or, at
  // either end of the script, across a nominal reading time outside the
  // narration, so that a hook the recogniser missed still appears before
  // the audio rather than on top of it.
  const words: AlignedWord[] = [];
  let interpolated = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    if (slots[i]) continue;
    let end = i;
    while (end + 1 < tokens.length && !slots[end + 1]) end += 1;

    const before = i > 0 ? slots[i - 1]! : null;
    let after: AlignedWord | null = null;
    for (let k = end + 1; k < tokens.length; k += 1) {
      if (slots[k]) {
        after = slots[k]!;
        break;
      }
    }

    const run = tokens.slice(i, end + 1);
    const NOMINAL_MS_PER_WORD = 380;
    const from = before ? before.endMs : (after?.startMs ?? first) - run.length * NOMINAL_MS_PER_WORD;
    const to = after ? after.startMs : (before?.endMs ?? last) + run.length * NOMINAL_MS_PER_WORD;

    const filled = distributeEvenly(run, from, to);
    for (let k = 0; k < filled.length; k += 1) slots[i + k] = filled[k]!;
    interpolated += run.length;
    i = end;
  }

  // Monotonicity, enforced rather than assumed. The passes above can leave
  // a one-millisecond overlap through rounding, and a cue builder that
  // groups on gaps reads an overlap as a pause of negative length.
  //
  // The floor is the previous word's end, not one past it. Continuous
  // speech genuinely produces `prev.endMs === next.startMs`, and nudging
  // those apart would rewrite timings that were already correct -- which is
  // the opposite of this module's job. Touching nothing that does not need
  // touching is also what makes a clean recogniser round-trip exactly.
  const MIN_WORD_MS = 24;
  let cursor = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const slot = slots[i]!;
    const startMs = Math.max(slot.startMs, cursor);
    const endMs = Math.max(slot.endMs, startMs + MIN_WORD_MS);
    words.push({ ...slot, startMs, endMs });
    cursor = endMs;
  }

  return {
    words,
    report: {
      scriptWords: tokens.length,
      heardWords: audible.length,
      matchRate: matched / tokens.length,
      distributed,
      interpolated,
    },
  };
}

/**
 * Whether an alignment is worth captioning from.
 *
 * Separate from `alignScript` on purpose. Alignment always returns its best
 * answer, and the decision to use it belongs to the caller, who knows
 * whether a human is waiting and what the fallback is.
 */
export function alignmentUsable(report: AlignmentReport): boolean {
  return report.scriptWords > 0 && report.matchRate >= MIN_MATCH_RATE;
}
