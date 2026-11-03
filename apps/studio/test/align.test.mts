/**
 * Forced alignment, against the recogniser output it exists to survive.
 *
 * The fixtures are not tidy. A recogniser that returned the script back
 * would make this module pointless, so every case here mangles the text the
 * way a real one does: brand names split in two, prices spelled out,
 * punctuation gone, a word dropped, a word invented.
 *
 * The property under test throughout is narrow and absolute: **what goes on
 * screen is the script**. Timing comes from the audio; not one character of
 * text does.
 */
import {
  MIN_MATCH_RATE,
  alignScript,
  alignmentUsable,
  normalise,
  tokeniseScript,
  type HeardWord,
} from "../src/lib/align.js";
import { REEL_STYLE, buildCues, cueProblems } from "../src/lib/subtitles.js";

let pass = 0;
let fail = 0;

const ok = (cond: boolean, what: string, extra = ""): void => {
  if (cond) {
    pass += 1;
    console.log(`  ok    ${what}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${what}${extra ? `\n          ${extra}` : ""}`);
  }
};

const eq = <T,>(actual: T, expected: T, what: string): void =>
  ok(actual === expected, what, `expected ${String(expected)}, got ${String(actual)}`);

/** `[text, startMs, endMs]` triples, at a confidence a good provider reports. */
const heard = (spec: readonly [string, number, number][], confidence = 0.95): HeardWord[] =>
  spec.map(([text, startMs, endMs]) => ({ text, startMs, endMs, confidence }));

// ---------------------------------------------------------------------------
console.log("\n## normalisation compares, it never rewrites");

{
  eq(normalise("Nayaverse,"), "nayaverse", "punctuation and case are stripped for comparison");
  eq(normalise("₹999"), "999", "a currency symbol is not part of the word");
  eq(normalise("--"), "", "a bare dash reduces to nothing");
  // The bug this caught: `\p{L}\p{N}` drops combining marks, so the matra
  // vanished and the word became a different word -- one that can now
  // collide with another. Compared as codepoints, never by eye.
  eq(normalise("घराजवळ"), "घराजवळ", "a Devanagari vowel sign is not stripped");
  eq(normalise("நன்றி"), "நன்றி", "nor a Tamil virama or vowel sign");
  ok(normalise("कार") !== normalise("कर"), "so कार and कर stay distinct words");
  eq(normalise("आहेत."), "आहेत", "while punctuation around them still goes");
  eq(tokeniseScript("a  b\n c ").length, 3, "tokens split on any run of whitespace");
}

// ---------------------------------------------------------------------------
console.log("\n## the case this module was written for");

{
  // What a recogniser actually returns for "Nayaverse costs ₹999 a month --
  // no watermark." Three separate failures in one line: the brand is two
  // words, the price is five, the compound is two.
  const script = "Nayaverse costs ₹999 a month -- no watermark.";
  const { words, report } = alignScript(
    script,
    heard([
      ["naya", 0, 300],
      ["verse", 300, 600],
      ["costs", 620, 900],
      ["nine", 950, 1150],
      ["hundred", 1150, 1450],
      ["ninety", 1450, 1750],
      ["nine", 1750, 1950],
      ["rupees", 1950, 2300],
      ["a", 2350, 2420],
      ["month", 2420, 2800],
      ["no", 2900, 3050],
      ["water", 3060, 3300],
      ["mark", 3300, 3600],
    ]),
  );

  eq(words.map((w) => w.text).join(" "), script, "the output text is the script, exactly");
  eq(words.length, 8, "eight script tokens out, not thirteen heard ones");

  const price = words.find((w) => w.text === "₹999")!;
  eq(price.source, "distributed", "the price got its time from the spoken run");
  eq(price.startMs, 950, "starting when the voice starts saying it");
  eq(price.endMs, 2300, "and ending when it stops -- all five spoken words");

  // The brand matched its first syllable, so without the hold rule the
  // caption would vanish at 300ms while the voice is still saying it.
  const brand = words[0]!;
  ok(brand.endMs >= 600, "the brand name stays up while the rest of it is said", `${brand.endMs}ms`);

  const dash = words.find((w) => w.text === "--")!;
  ok(dash !== undefined, "a token that normalises to nothing is still emitted");
  ok(dash.source === "interpolated", "with an interpolated time");

  ok(report.matchRate >= 0.5, `matchRate ${report.matchRate.toFixed(2)} on heavy mangling`);
  ok(alignmentUsable(report), "and the alignment is judged usable");
}

// ---------------------------------------------------------------------------
console.log("\n## timings are monotonic and non-overlapping");

{
  const script = "Three reels a day, every day, without a camera.";
  const { words } = alignScript(
    script,
    heard([
      ["three", 0, 300],
      ["reels", 300, 700],
      ["a", 700, 760],
      ["day", 760, 1100],
      ["every", 1400, 1700],
      ["day", 1700, 2000],
      ["without", 2300, 2700],
      ["a", 2700, 2760],
      ["camera", 2760, 3300],
    ]),
  );

  let monotonic = true;
  let positive = true;
  for (let i = 0; i < words.length; i += 1) {
    if (words[i]!.endMs <= words[i]!.startMs) positive = false;
    if (i > 0 && words[i]!.startMs <= words[i - 1]!.endMs - 1) monotonic = false;
  }
  ok(positive, "every word has a positive duration");
  ok(monotonic, "and none overlaps the one before it");
  eq(words.map((w) => w.text).join(" "), script, "text still exactly the script");
}

// ---------------------------------------------------------------------------
console.log("\n## a word the recogniser never heard");

{
  // "absolutely" is simply missing from the audio's transcript. Dropping it
  // would be silently editing what the creator wrote.
  const script = "This is absolutely free to try.";
  const { words, report } = alignScript(
    script,
    heard([
      ["this", 0, 200],
      ["is", 200, 340],
      ["free", 900, 1200],
      ["to", 1200, 1320],
      ["try", 1320, 1700],
    ]),
  );

  eq(words.map((w) => w.text).join(" "), script, "the missing word is still in the output");
  const missing = words.find((w) => w.text === "absolutely")!;
  eq(missing.source, "interpolated", "marked as interpolated, not matched");
  ok(missing.confidence <= 0.2, "and carrying low confidence", `${missing.confidence}`);
  ok(
    missing.startMs >= 340 && missing.endMs <= 900,
    "placed in the silence where it must have been said",
    `${missing.startMs}-${missing.endMs}ms`,
  );
  eq(report.interpolated, 1, "one word reported as interpolated");
}

// ---------------------------------------------------------------------------
console.log("\n## a reader who improvised");

{
  // The narrator added half a sentence that is not in the script. There is
  // no script token to carry it, and the previous caption must not be held
  // across all of it.
  const script = "Pick a plan.";
  const { words } = alignScript(
    script,
    heard([
      ["pick", 0, 300],
      ["a", 300, 360],
      ["plan", 360, 700],
      ["and", 800, 900],
      ["honestly", 900, 1400],
      ["any", 1400, 1600],
      ["one", 1600, 1900],
      ["of", 1900, 2000],
      ["them", 2000, 2400],
    ]),
  );

  eq(words.map((w) => w.text).join(" "), script, "the improvisation is not captioned");
  const last = words[words.length - 1]!;
  ok(
    last.endMs <= 1100,
    "and the last script word is not stretched across it",
    `held to ${last.endMs}ms against 2400ms of speech`,
  );
}

// ---------------------------------------------------------------------------
console.log("\n## a narration of something else entirely");

{
  // The one case alignment must refuse. It cannot tell "wrong audio" from
  // "terrible recogniser", and captioning either would be confident
  // nonsense.
  const script = "Nayaverse gives every clinic its own website.";
  const { report } = alignScript(
    script,
    heard([
      ["the", 0, 200],
      ["mitochondrion", 200, 900],
      ["is", 900, 1000],
      ["the", 1000, 1100],
      ["powerhouse", 1100, 1700],
      ["of", 1700, 1800],
      ["the", 1800, 1900],
      ["cell", 1900, 2300],
    ]),
  );

  ok(
    report.matchRate < MIN_MATCH_RATE,
    `matchRate ${report.matchRate.toFixed(2)} is below the ${MIN_MATCH_RATE} floor`,
  );
  ok(!alignmentUsable(report), "so the alignment is refused rather than used");
}

// ---------------------------------------------------------------------------
console.log("\n## a clean recogniser, and ordinary drift");

{
  const script = "Book an appointment online.";
  const clean = alignScript(
    script,
    heard([
      ["Book", 0, 300],
      ["an", 300, 420],
      ["appointment", 420, 1100],
      ["online", 1100, 1600],
    ]),
  );
  eq(clean.report.matchRate, 1, "a perfect transcript matches every word");
  eq(clean.report.interpolated, 0, "with nothing interpolated");
  eq(clean.words[0]!.source, "matched", "and every word sourced from a match");
  eq(clean.words.map((w) => w.text).join(" "), script, "capitalisation comes from the script");

  // One character wrong inside a long word is drift, not a different word.
  const drift = alignScript(
    "Doctor Momin is available today.",
    heard([
      ["doctor", 0, 300],
      ["mommin", 300, 700],
      ["is", 700, 800],
      ["available", 800, 1400],
      ["today", 1400, 1900],
    ]),
  );
  eq(drift.report.matchRate, 1, "a one-edit misspelling still matches");
  eq(
    drift.words[1]!.text,
    "Momin",
    "and the script's spelling wins over the recogniser's",
  );

  // Short words must not pair loosely: "ride" and "rude" are not drift.
  const shortWords = alignScript(
    "rude",
    heard([["ride", 0, 400]]),
  );
  eq(shortWords.report.matchRate, 0, "a one-edit four-letter word is not treated as a match");
  eq(shortWords.words[0]!.text, "rude", "but the script token is still emitted and timed");
}

// ---------------------------------------------------------------------------
console.log("\n## twelve languages means the script is not ASCII");

{
  const script = "आज डॉक्टर उपलब्ध आहेत.";
  const { words, report } = alignScript(
    script,
    heard([
      ["आज", 0, 300],
      ["डॉक्टर", 300, 900],
      ["उपलब्ध", 900, 1500],
      ["आहेत", 1500, 2000],
    ]),
  );
  eq(words.map((w) => w.text).join(" "), script, "Marathi aligns and round-trips exactly");
  eq(report.matchRate, 1, "every Devanagari token matched its own audio");
  // The failure this guards: if normalisation emptied these tokens they
  // would all compare equal and the alignment would be meaningless.
  ok(
    words[0]!.startMs === 0 && words[3]!.startMs === 1500,
    "and each word kept its own timing, not a shared one",
  );
}

// ---------------------------------------------------------------------------
console.log("\n## defensive handling");

{
  const outOfOrder = alignScript(
    "one two three",
    heard([
      ["three", 700, 1000],
      ["one", 0, 300],
      ["two", 300, 700],
    ]),
  );
  eq(outOfOrder.words[0]!.text, "one", "a provider's out-of-order correction is sorted");
  eq(outOfOrder.words[0]!.startMs, 0, "so the first word gets the first timing");

  const noAudio = alignScript("still has to render", []);
  eq(noAudio.words.length, 4, "a script with no transcript still yields every word");
  ok(!alignmentUsable(noAudio.report), "but is not claimed to be aligned");

  const empty = alignScript("   ", heard([["anything", 0, 100]]));
  eq(empty.words.length, 0, "an empty script yields no words");
  ok(!alignmentUsable(empty.report), "and is not usable");

  const zeroWidth = alignScript(
    "a b",
    heard([
      ["a", 0, 0],
      ["b", 100, 200],
    ]),
  );
  eq(zeroWidth.words.length, 2, "a zero-length heard word is discarded, not divided by");
  ok(zeroWidth.words[0]!.endMs > zeroWidth.words[0]!.startMs, "and the script word still has width");
}

// ---------------------------------------------------------------------------
console.log("\n## end to end: alignment feeding the caption engine");

{
  // The whole point of the module: real cues, with the script's spelling,
  // at the audio's timing.
  const script = "Stop editing reels by hand. Nayaverse writes, voices and cuts it for ₹999.";
  const { words, report } = alignScript(
    script,
    heard([
      ["stop", 0, 300],
      ["editing", 300, 800],
      ["reels", 800, 1200],
      ["by", 1200, 1320],
      ["hand", 1320, 1700],
      ["naya", 2100, 2400],
      ["verse", 2400, 2700],
      ["writes", 2750, 3200],
      ["voices", 3250, 3700],
      ["and", 3700, 3820],
      ["cuts", 3820, 4200],
      ["it", 4200, 4300],
      ["for", 4300, 4450],
      ["nine", 4500, 4700],
      ["hundred", 4700, 5000],
      ["ninety", 5000, 5300],
      ["nine", 5300, 5500],
      ["rupees", 5500, 5900],
    ]),
  );

  ok(alignmentUsable(report), "the alignment is usable");
  const cues = buildCues(words, REEL_STYLE);
  ok(cues.length >= 3, `${cues.length} cues built from the aligned words`);

  const onScreen = cues.flatMap((c) => c.lines).join(" ");
  ok(onScreen.includes("₹999"), "the price reads ₹999 on screen, not nine hundred ninety nine");
  ok(onScreen.includes("Nayaverse"), "and the brand name is one word");
  ok(!onScreen.includes("naya verse"), "the recogniser's split never reaches the screen");
  ok(!/rupees/i.test(onScreen), "nor its spelled-out price");

  // Every cue must still satisfy the style the reel is captioned in -- the
  // alignment is not allowed to produce timings `buildCues` cannot honour.
  const problems = cueProblems(cues, REEL_STYLE);
  eq(problems.length, 0, "and no cue breaks the reel caption style", JSON.stringify(problems));

  let ordered = true;
  for (let i = 1; i < cues.length; i += 1) {
    if (cues[i]!.startMs < cues[i - 1]!.endMs) ordered = false;
  }
  ok(ordered, "cues are in order and do not overlap");

  // Reassembling the cues must give back the script: nothing lost in
  // grouping, nothing invented.
  const fromCues = cues.flatMap((c) => c.words.map((w) => w.text)).join(" ");
  eq(fromCues, script, "and the cues together still spell out the script exactly");
}

// ---------------------------------------------------------------------------
console.log("\n## the fallback is marked as a fallback");

{
  // A script far too long to align against a transcript this short. The
  // result is a crude even spread -- which is fine, as long as nothing
  // downstream can mistake it for alignment.
  const long = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");
  const { words, report } = alignScript(long, heard([["word0", 0, 400]]));
  eq(words.length, 300, "every word is still emitted");
  ok(
    words.every((w) => w.source === "interpolated" || w.source === "matched"),
    "and none is claimed to be distributed from real audio",
  );
  ok(report.matchRate < MIN_MATCH_RATE, "the report makes the weakness visible");
}

// ---------------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
