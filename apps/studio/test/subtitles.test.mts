/**
 * Caption timing, checked without a renderer.
 *
 * The property that matters most is the last section: captions have to
 * survive editing. A creator trims two seconds off the front of a clip and
 * every caption after that point must move with it -- get that wrong and
 * the whole reel is subtly out of sync in a way that is obvious to watch
 * and maddening to diagnose.
 */
import {
  REEL_STYLE,
  SUBTITLE_STYLE,
  buildCues,
  captionAt,
  cueAt,
  cueProblems,
  cuesForClip,
  layoutLines,
  toSRT,
  toVTT,
  type Cue,
  type CueStyle,
  type Word,
} from '../src/lib/subtitles.js';

let pass = 0;
let fail = 0;
const ok = (c: boolean, what: string, extra = '') => {
  if (c) {
    pass += 1;
    console.log(`  ok    ${what}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${what}${extra ? `\n          ${extra}` : ''}`);
  }
};
const eq = (a: number, b: number, what: string, tol = 1e-6) =>
  ok(Math.abs(a - b) <= tol, what, `expected ${b}, got ${a}`);

/** Words at a steady pace, which is the easy case to reason about. */
const say = (text: string, startMs = 0, perWordMs = 300, gapMs = 0): Word[] => {
  let at = startMs;
  return text.split(/\s+/).filter(Boolean).map((t) => {
    const w: Word = { text: t, startMs: at, endMs: at + perWordMs, confidence: 0.95 };
    at += perWordMs + gapMs;
    return w;
  });
};

const text = (c: Cue) => c.lines.join(' ');
const dur = (c: Cue) => c.endMs - c.startMs;

// ---------------------------------------------------------------------------
console.log('\nnothing in, nothing out');
{
  ok(buildCues([], REEL_STYLE).length === 0, 'no words means no cues');
  ok(
    buildCues([{ text: '   ', startMs: 0, endMs: 100, confidence: 1 }], REEL_STYLE).length === 0,
    'whitespace-only words are dropped, not rendered blank',
  );
  ok(cueAt([], 500) === null, 'nothing is on screen');
  ok(captionAt([], 500) === '', 'and the caption is empty, not undefined');
  ok(toSRT([]) === '', 'an empty SRT is empty, not a stray newline');
}

console.log('\ngrouping: the reel style keeps cues short');
{
  const cues = buildCues(say('this is a sentence of eight separate words here'), REEL_STYLE);
  ok(cues.length >= 2, 'nine words become several cues', String(cues.length));
  ok(
    cues.every((c) => c.words.length <= REEL_STYLE.maxWords),
    'no cue exceeds the word cap',
    cues.map((c) => c.words.length).join(','),
  );
  // Nothing may be lost or duplicated: the words out must be the words in.
  const rebuilt = cues.flatMap((c) => c.words.map((w) => w.text)).join(' ');
  ok(
    rebuilt === 'this is a sentence of eight separate words here',
    'every word survives, in order',
    rebuilt,
  );
}

console.log('\ngrouping: a real pause is a break');
{
  // Two phrases with a clear silence between them.
  const a = say('first phrase here', 0, 250, 0);
  const b = say('second phrase here', 2000, 250, 0);
  const cues = buildCues([...a, ...b], REEL_STYLE);
  ok(cues.length >= 2, 'the pause splits them', String(cues.length));
  const spanning = cues.find((c) => c.startMs < 1000 && c.endMs > 1900);
  ok(spanning === undefined, 'and no cue spans the silence');
}

console.log('\ngrouping: a sentence end is a break');
{
  const cues = buildCues(say('stop here. now continue', 0, 200), REEL_STYLE);
  const first = cues[0]!;
  ok(text(first).endsWith('here.'), 'the first cue ends at the full stop', text(first));
  ok(
    !text(first).includes('now'),
    'and does not carry the next sentence in',
    text(first),
  );
}
{
  // Devanagari danda, since this product captions Marathi and Hindi.
  const cues = buildCues(say('हे काम करते। पुढे बघा', 0, 200), REEL_STYLE);
  ok(cues.length >= 2, 'a danda breaks a sentence too', String(cues.length));
  ok(text(cues[0]!).includes('।'), 'the danda stays with its sentence');
}

console.log('\nno orphaned single words');
{
  // "it" alone at the end of a sentence is the classic case.
  const cues = buildCues(say('here are four words it', 0, 220), REEL_STYLE);
  const orphans = cues.filter((c) => c.words.length === 1 && c.words[0]!.text.length <= 4);
  eq(orphans.length, 0, 'a short trailing word is merged backwards', 0);
}
{
  // But not across a pause -- that break was chosen for an audible reason.
  const a = say('a full phrase here', 0, 200);
  const b = say('it', 3000, 200);
  const cues = buildCues([...a, ...b], REEL_STYLE);
  const last = cues[cues.length - 1]!;
  ok(last.words.length === 1, 'a word after a long silence stays on its own');
  ok(last.startMs >= 3000, 'at its own time', String(last.startMs));
}

// ---------------------------------------------------------------------------
console.log('\ntiming: minimum, maximum, and never overlapping');
{
  const cues = buildCues(say('one two three four five six seven eight', 0, 120), REEL_STYLE);
  ok(
    cues.every((c, i) => {
      const next = cues[i + 1];
      return !next || next.startMs >= c.endMs;
    }),
    'no cue overlaps the next',
    cues.map((c) => `${c.startMs}-${c.endMs}`).join(' '),
  );
  ok(
    cues.every((c, i) => {
      const next = cues[i + 1];
      return !next || next.startMs - c.endMs >= REEL_STYLE.minGapMs - 1;
    }),
    'and a visible gap is left between them',
  );
  ok(
    cues.every((c) => dur(c) <= REEL_STYLE.maxDurationMs + 1),
    'none is held past the maximum',
  );
}
{
  // A single very short word, with plenty of silence after it: the floor
  // should be applied, because nothing is competing for the time.
  const cues = buildCues(
    [
      { text: 'go', startMs: 1000, endMs: 1080, confidence: 0.9 },
      { text: 'later', startMs: 9000, endMs: 9300, confidence: 0.9 },
    ],
    REEL_STYLE,
  );
  const first = cues[0]!;
  ok(
    dur(first) >= REEL_STYLE.minDurationMs,
    'a flash of a word is extended to the readable floor',
    `${dur(first)}ms`,
  );
  ok(first.endMs < 9000, 'but not into the next cue', String(first.endMs));
}
{
  // Crowded: two complete sentences almost back to back, so neither cue
  // can be given its full floor and neither can be merged away. The
  // checker must say so rather than the builder overlapping them.
  //
  // An earlier version of this fixture used three bare words, and the
  // orphan rule correctly merged them into one roomy cue -- so there was
  // no compromise to report and the test was wrong, not the code.
  const cues = buildCues(
    [
      { text: 'alpha', startMs: 0, endMs: 100, confidence: 0.9 },
      { text: 'beta.', startMs: 100, endMs: 200, confidence: 0.9 },
      { text: 'gamma', startMs: 210, endMs: 310, confidence: 0.9 },
      { text: 'delta.', startMs: 310, endMs: 410, confidence: 0.9 },
    ],
    SUBTITLE_STYLE,
  );
  ok(cues.length === 2, 'two sentences stay two cues', String(cues.length));
  ok(
    cues.every((c, i) => {
      const next = cues[i + 1];
      return !next || next.startMs >= c.endMs;
    }),
    'crowded cues still never overlap',
  );
  const problems = cueProblems(cues, SUBTITLE_STYLE);
  ok(
    problems.some((p) => p.what.includes('floor')),
    'and the compromise is reported, not hidden',
    problems.map((p) => p.what).join(' | '),
  );
}

console.log('\ntiming: reading speed');
{
  // A long line spoken fast. Under the subtitle style this must be given
  // more time than the words themselves occupy.
  const words = say('a fairly long sentence with many words spoken very quickly indeed', 0, 90);
  const cues = buildCues(words, SUBTITLE_STYLE);
  for (const c of cues) {
    const chars = text(c).length;
    const cps = chars / (dur(c) / 1000);
    const last = cues[cues.length - 1] === c;
    ok(
      cps <= SUBTITLE_STYLE.maxCps * 1.05 || !last,
      `reading speed ${cps.toFixed(1)} cps is within the limit`,
      `${chars} chars in ${dur(c)}ms`,
    );
  }
}

// ---------------------------------------------------------------------------
console.log('\nline layout is balanced, not greedy');
{
  const words = say('one two three four five six seven', 0, 100);
  const lines = layoutLines(words, { ...SUBTITLE_STYLE, maxCharsPerLine: 18, maxLines: 2 });
  ok(lines.length === 2, 'wrapped to two lines', lines.join(' | '));
  const [a, b] = lines as [string, string];
  // Greedy would put almost everything on the first line.
  ok(
    Math.abs(a.length - b.length) <= 8,
    'the two lines are close in length',
    `${a.length} vs ${b.length}`,
  );
  ok(
    lines.every((l) => l.length <= 18),
    'and neither exceeds the limit',
    lines.map((l) => l.length).join(','),
  );
  ok(lines.join(' ') === 'one two three four five six seven', 'with no words lost');
}
{
  // A single word longer than the line cannot be broken without
  // hyphenation rules this product does not have.
  const long = layoutLines(say('antidisestablishmentarianism'), {
    ...REEL_STYLE,
    maxCharsPerLine: 10,
  });
  ok(long.length === 1, 'an unbreakable word stays whole');
  ok(long[0] === 'antidisestablishmentarianism', 'and is not truncated', long[0]);
}

console.log('\nwhat is on screen when');
{
  const cues = buildCues(say('alpha beta gamma delta epsilon zeta', 0, 300), REEL_STYLE);
  const first = cues[0]!;
  ok(cueAt(cues, first.startMs) === first, 'a cue is on at its start');
  ok(cueAt(cues, first.endMs) !== first, 'and off at its end -- half-open, so none overlap');
  ok(cueAt(cues, -100) === null, 'nothing before the first');
  ok(cueAt(cues, 999_999) === null, 'nothing after the last');
  ok(captionAt(cues, first.startMs).length > 0, 'the caption text comes back');
  ok(
    captionAt(cues, first.startMs).includes('\n') === first.lines.length > 1,
    'multi-line cues are joined with a newline, which the solver wraps on',
  );
}

// ---------------------------------------------------------------------------
console.log('\ncaptions survive editing -- the property that matters');
{
  // Ten seconds of speech, then the creator uses only 4s-7s of it and
  // places that at 2s on the finished reel.
  const words = say('one two three four five six seven eight nine ten', 0, 400, 600);
  const cues = buildCues(words, REEL_STYLE);
  ok(cues.length > 2, 'several cues across the recording', String(cues.length));

  const clipped = cuesForClip(cues, 4000, 3000, 2000);
  ok(clipped.length > 0, 'some cues fall inside the used part', String(clipped.length));
  ok(
    clipped.every((c) => c.startMs >= 2000 - 1 && c.endMs <= 5000 + 1),
    'and every one lands inside the shot on the timeline',
    clipped.map((c) => `${c.startMs}-${c.endMs}`).join(' '),
  );
  // The shift must be exactly sourceIn -> timelineStart.
  const inWindow = cues.filter((c) => c.endMs > 4000 && c.startMs < 7000);
  eq(clipped.length, inWindow.length, 'no cue in the window is dropped');
  const firstIn = inWindow[0]!;
  eq(
    clipped[0]!.startMs,
    Math.max(firstIn.startMs, 4000) - 4000 + 2000,
    'and the first is shifted by exactly the trim',
  );

  // Nothing from outside the window may leak in.
  const early = cuesForClip(cues, 4000, 3000, 2000).filter((c) =>
    c.words.some((w) => w.endMs < 3000),
  );
  ok(early.length === 0 || early.every((c) => c.startMs >= 2000), 'nothing from before the cut leaks in');
}
{
  // A cue straddling the cut must be clipped, not dropped and not allowed
  // to run past the end of the shot.
  const cues: Cue[] = [
    { startMs: 900, endMs: 2100, lines: ['straddles'], words: say('straddles', 900) },
  ];
  const clipped = cuesForClip(cues, 1000, 1000, 0);
  ok(clipped.length === 1, 'kept');
  eq(clipped[0]!.startMs, 0, 'clipped at the shot start');
  eq(clipped[0]!.endMs, 1000, 'and at the shot end');
}
{
  const cues: Cue[] = [{ startMs: 0, endMs: 500, lines: ['before'], words: say('before') }];
  ok(cuesForClip(cues, 2000, 1000, 0).length === 0, 'a cue entirely before the cut is dropped');
  ok(cuesForClip(cues, 0, 1000, 0).length === 1, 'and one inside it is kept');
}
{
  // Reordering: two shots from one recording, played back to back in the
  // opposite order. Each keeps its own words.
  const words = say('first part here second part there', 0, 300, 100);
  const cues = buildCues(words, REEL_STYLE);
  const later = cuesForClip(cues, 1200, 1200, 0); // the second half, placed first
  const earlier = cuesForClip(cues, 0, 1200, 1200); // the first half, placed second
  ok(later.length > 0 && earlier.length > 0, 'both halves carry cues');
  ok(
    later.every((c) => c.endMs <= 1200 + 1) && earlier.every((c) => c.startMs >= 1200 - 1),
    'and neither bleeds into the other after reordering',
  );
  const laterText = later.flatMap((c) => c.words.map((w) => w.text)).join(' ');
  ok(!laterText.includes('first'), "the reordered shot does not show the other shot's words", laterText);
}

// ---------------------------------------------------------------------------
console.log('\nthe checker catches real violations');
{
  const bad: Cue[] = [
    { startMs: 0, endMs: 100, lines: ['much too brief to read'], words: say('x') },
    { startMs: 50, endMs: 900, lines: ['overlapping'], words: say('y') },
  ];
  const problems = cueProblems(bad, SUBTITLE_STYLE);
  ok(problems.some((p) => p.what.includes('floor')), 'a too-brief cue is caught');
  ok(problems.some((p) => p.what.includes('overlaps')), 'an overlap is caught');
  ok(problems.some((p) => p.severe), 'and at least one is marked severe');
}
{
  const tooLong: Cue[] = [
    {
      startMs: 0,
      endMs: 1000,
      lines: ['this single line is far longer than the forty-two character limit allows'],
      words: say('x'),
    },
  ];
  const problems = cueProblems(tooLong, SUBTITLE_STYLE);
  ok(problems.some((p) => p.what.includes('characters, over')), 'an over-long line is caught');
  ok(problems.some((p) => p.what.includes('per second')), 'and so is the reading speed');
}
{
  // The happy path must be quiet, or the checker is noise.
  const clean = buildCues(say('a calm sentence with a normal pace of delivery', 0, 420, 80), SUBTITLE_STYLE);
  const problems = cueProblems(clean, SUBTITLE_STYLE);
  ok(
    problems.filter((p) => p.severe).length === 0,
    'well-formed cues raise nothing severe',
    problems.map((p) => p.what).join(' | '),
  );
}

// ---------------------------------------------------------------------------
console.log('\ninterchange formats');
{
  const cues = buildCues(say('hello there friend', 1500, 400), SUBTITLE_STYLE);
  const srt = toSRT(cues);
  console.log(`        ${srt.split('\n').slice(0, 3).join(' / ')}`);
  ok(srt.startsWith('1\n'), 'SRT is one-indexed');
  ok(/\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/.test(srt), 'with comma milliseconds');
  ok(srt.includes('hello'), 'and the words');
  ok(srt.endsWith('\n'), 'and a trailing newline, which some parsers require');

  const vtt = toVTT(cues);
  ok(vtt.startsWith('WEBVTT\n'), 'VTT carries its header');
  ok(/\d{2}:\d{2}:\d{2}\.\d{3} --> /.test(vtt), 'and uses a full stop for milliseconds');

  // An hour in, to catch a timestamp that only works for short clips.
  const late = toSRT([{ startMs: 3_725_500, endMs: 3_726_000, lines: ['late'], words: [] }]);
  ok(late.includes('01:02:05,500'), 'an hour-long offset formats correctly', late.split('\n')[1]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
