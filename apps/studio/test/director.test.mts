/**
 * The director: a scene plan and a library in, an editable cut out.
 *
 * The properties that matter are the ones a creator would notice first --
 * the right clip under the right line, no clip shown twice for the same
 * two seconds, captions that land inside their own shot -- and the one
 * they would notice last, which is that the same input gives the same cut
 * every time.
 */
import {
  MIN_SHOT_SECONDS,
  directReel,
  matchWords,
  paceWords,
  shotSeconds,
  type LibraryItem,
} from "../src/lib/director.js";
import { planFromScript } from "../src/lib/scenes.js";
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

const SCRIPT =
  "Patients search for you and find nothing. " +
  "Your reception desk answers the same timing question all day. " +
  "Nayaverse gives your clinic its own page with services and directions. " +
  "It speaks twelve Indian languages. " +
  "Book a demo this week.";

// ---------------------------------------------------------------------------
console.log("\n## matching on the names creators actually give files");

{
  const words = (s: string) => [...matchWords(s)].sort().join(",");
  eq(words("drConsultRoom2.mp4"), "consult,room", "camelCase splits, and a two-letter word is not a subject");
  eq(words("reception_desk-final.MOV"), "desk,reception", "underscores and dashes split; 'final' is noise");
  eq(words("IMG_20260114_093011.jpg"), "", "a camera filename is a date, not a subject");
  ok(matchWords("patient-queue.jpg").has("patient"), "a singular file name");
  ok(matchWords("Patients wait in the queue").has("patient"), "matches a plural in the script");
  ok(matchWords("घराजवळ_दवाखाना.jpg").has("घराजवळ"), "a Devanagari file name keeps its vowel signs");
}

// ---------------------------------------------------------------------------
console.log("\n## pacing words before any narration exists");

{
  const words = paceWords("Patients search for you and find nothing.", 3);
  eq(words.length, 7, "one timed word per script word");
  eq(words.map((w) => w.text).join(" "), "Patients search for you and find nothing.", "text is the line, exactly");
  ok(words[0]!.startMs > 0, "the first word does not land on the cut");
  ok(words[words.length - 1]!.endMs < 3000, "and the last finishes before the shot ends");
  let ordered = true;
  for (let i = 0; i < words.length; i += 1) {
    if (words[i]!.endMs <= words[i]!.startMs) ordered = false;
    if (i > 0 && words[i]!.startMs < words[i - 1]!.endMs) ordered = false;
  }
  ok(ordered, "every word has width and none overlaps the last");
  const a = words.find((w) => w.text === "and")!;
  const p = words.find((w) => w.text === "Patients")!;
  ok(p.endMs - p.startMs > a.endMs - a.startMs, "a long word is given longer than a short one");
  eq(paceWords("   ", 2).length, 0, "an empty line paces no words");
}

{
  const short = planFromScript("Go.");
  ok(shotSeconds(short.hook) >= MIN_SHOT_SECONDS, `a one-word line still gets ${MIN_SHOT_SECONDS}s on screen`);
}

// ---------------------------------------------------------------------------
console.log("\n## with no footage, every line becomes a text card");

{
  const reel = directReel(planFromScript(SCRIPT), []);
  ok(reel.shots.length >= 4, `${reel.shots.length} shots`);
  eq(reel.cards, reel.shots.length, "all of them cards");
  eq(reel.shots[0]!.role, "hook", "the first is the hook");
  eq(reel.shots[reel.shots.length - 1]!.role, "cta", "the last is the call to action");
  // A card's label is drawn into the exported picture, so the Director
  // leaves it empty: "Hook" burnt into a reel was a bug the first visual
  // check caught. The role is carried by `role`, for the editor to show.
  ok(
    reel.shots.every((s) => s.source.kind === "solid" && s.source.label === ""),
    "and no card carries a label that would be drawn into the reel",
  );
  eq(reel.shots[0]!.role, "hook", "the role travels separately, for the running order");
  ok(reel.shots.every((s) => s.match.kind === "card"), "every reason says 'card'");
  const total = reel.shots.reduce((sum, s) => sum + s.seconds, 0);
  ok(Math.abs(total - reel.totalSeconds) < 0.002, "and the total is the sum of the shots");
}

// ---------------------------------------------------------------------------
console.log("\n## footage is matched to the line it belongs under");

{
  const library: LibraryItem[] = [
    { name: "city-traffic.mp4", kind: "clip", seconds: 20 },
    { name: "reception_desk.mp4", kind: "clip", seconds: 12 },
    { name: "clinic-services-board.jpg", kind: "photo", seconds: null },
    { name: "phone-search.jpg", kind: "photo", seconds: null },
  ];
  const reel = directReel(planFromScript(SCRIPT), library, { fill: false });
  const under = (fragment: string) => reel.shots.find((s) => s.text.includes(fragment))!;

  const desk = under("reception desk");
  ok(
    desk.source.kind === "clip" && desk.source.path === "reception_desk.mp4",
    "the reception line gets the reception clip",
    JSON.stringify(desk.source),
  );
  ok(
    desk.match.kind === "keyword" && desk.match.on.includes("reception"),
    "and records the word it matched on",
    JSON.stringify(desk.match),
  );

  const services = under("services and directions");
  ok(
    services.source.kind === "photo" && services.source.path === "clinic-services-board.jpg",
    "the services line gets the services photo",
    JSON.stringify(services.source),
  );

  const hook = under("search for you");
  ok(
    hook.source.kind === "photo" && hook.source.path === "phone-search.jpg",
    "the hook gets the search screenshot",
    JSON.stringify(hook.source),
  );

  ok(
    !reel.shots.some((s) => s.source.kind !== "solid" && s.source.path === "city-traffic.mp4"),
    "and unrelated footage is not used when filling is off",
  );
}

// ---------------------------------------------------------------------------
console.log("\n## a clip is never asked for more than it holds");

{
  const library: LibraryItem[] = [{ name: "reception.mp4", kind: "clip", seconds: 1 }];
  const reel = directReel(planFromScript(SCRIPT), library, { fill: false });
  ok(
    reel.shots.every((s) => s.source.kind !== "clip"),
    "a one-second clip is not stretched under a four-second line",
  );
}

{
  // One long take carrying several scenes: each use takes the next stretch.
  const library: LibraryItem[] = [{ name: "clinic-broll.mp4", kind: "clip", seconds: 60 }];
  const reel = directReel(planFromScript(SCRIPT), library);
  const spans = reel.shots
    .filter((s) => s.source.kind === "clip")
    .map((s) => (s.source.kind === "clip" ? [s.source.from, s.source.to] : [0, 0]) as [number, number]);
  ok(spans.length === reel.shots.length, "a long take fills every shot when it has to");
  let disjoint = true;
  for (let i = 1; i < spans.length; i += 1) if (spans[i]![0] < spans[i - 1]![1]) disjoint = false;
  ok(disjoint, "with no two shots showing the same seconds of it");
  ok(
    reel.shots.every((s) => s.source.kind !== "clip" || Math.abs(s.source.to - s.source.from - s.seconds) < 0.002),
    "and each stretch exactly as long as its shot",
  );
}

{
  // The take runs out partway: later shots must not be placed past its end.
  const library: LibraryItem[] = [{ name: "clinic-broll.mp4", kind: "clip", seconds: 7 }];
  const reel = directReel(planFromScript(SCRIPT), library);
  ok(
    reel.shots.every((s) => s.source.kind !== "clip" || s.source.to <= 7),
    "no stretch is placed past the end of the file",
  );
  ok(reel.cards > 0, "and the shots it cannot cover become cards instead");
}

// ---------------------------------------------------------------------------
console.log("\n## filling, and not filling");

{
  const library: LibraryItem[] = [
    { name: "IMG_0001.jpg", kind: "photo", seconds: null },
    { name: "IMG_0002.jpg", kind: "photo", seconds: null },
  ];
  const filled = directReel(planFromScript(SCRIPT), library);
  eq(filled.cards, 0, "with filling on, uploaded footage keeps the picture moving");
  ok(filled.fills > 0, "and each such shot is labelled a fill, not a match");
  const first = filled.shots[0]!.source;
  const second = filled.shots[1]!.source;
  ok(
    first.kind === "photo" && second.kind === "photo" && first.path !== second.path,
    "fills spread across the library rather than repeating the first file",
  );

  const strict = directReel(planFromScript(SCRIPT), library, { fill: false });
  eq(strict.cards, strict.shots.length, "with filling off, nothing unmatched is placed");
}

// ---------------------------------------------------------------------------
console.log("\n## what is shown outranks what is said");

{
  // The scene says "desk" but asks to see a "board". The board wins.
  const plan = planFromScript("Hook here now. The desk has a board of services listed.");
  const scene = { ...plan.scenes[0]!, visual: "services board" };
  const reel = directReel({ ...plan, scenes: [scene] }, [
    { name: "front-desk.jpg", kind: "photo", seconds: null },
    { name: "services-board.jpg", kind: "photo", seconds: null },
  ], { fill: false });
  const shot = reel.shots.find((s) => s.role === "scene")!;
  ok(
    shot.source.kind === "photo" && shot.source.path === "services-board.jpg",
    "a match on the visual query beats a match on the narration",
    JSON.stringify(shot.source),
  );
}

// ---------------------------------------------------------------------------
console.log("\n## the same input gives the same cut");

{
  const library: LibraryItem[] = [
    { name: "reception_desk.mp4", kind: "clip", seconds: 12 },
    { name: "clinic-services-board.jpg", kind: "photo", seconds: null },
    { name: "IMG_0003.jpg", kind: "photo", seconds: null },
  ];
  const a = JSON.stringify(directReel(planFromScript(SCRIPT), library));
  const b = JSON.stringify(directReel(planFromScript(SCRIPT), library));
  ok(a === b, "re-running the director does not reshuffle the picture");
}

// ---------------------------------------------------------------------------
console.log("\n## the directed words make valid reel captions");

{
  const reel = directReel(planFromScript(SCRIPT), []);
  let offset = 0;
  const words = reel.shots.flatMap((s) => {
    const shifted = s.words.map((w) => ({ ...w, startMs: w.startMs + offset, endMs: w.endMs + offset }));
    offset += Math.round(s.seconds * 1000);
    return shifted;
  });
  const cues = buildCues(words, REEL_STYLE);
  ok(cues.length >= reel.shots.length, `${cues.length} cues across ${reel.shots.length} shots`);
  eq(cueProblems(cues, REEL_STYLE).length, 0, "and none breaks the reel caption style", JSON.stringify(cueProblems(cues, REEL_STYLE)));
  eq(
    cues.flatMap((c) => c.words.map((w) => w.text)).join(" "),
    SCRIPT,
    "and together they spell out the script exactly",
  );
  // A cue that ran across a cut would put one shot's words over the next
  // shot's picture -- the visible symptom of pacing that ignores the edit.
  const cuts = reel.shots.reduce<number[]>((acc, s) => [...acc, (acc[acc.length - 1] ?? 0) + Math.round(s.seconds * 1000)], []);
  const straddles = cues.filter((c) => cuts.some((t) => c.startMs < t && c.endMs > t + 1));
  eq(straddles.length, 0, "and no cue runs across a cut");
}

// ---------------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
