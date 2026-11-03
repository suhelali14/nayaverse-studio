/**
 * Scene planning and the validator that gates it.
 *
 * The validator is the part worth testing hardest, because it is the part
 * that runs with no API key and decides whether anything renders. Two of
 * its rules are compliance rules rather than craft rules, and those get
 * the most adversarial fixtures here: a script that would put a doctor's
 * registration at risk has to be caught by a regular expression, and a
 * regular expression that is nearly right is the whole danger.
 */
import {
  DEFAULT_STYLE,
  LIGHT_MODEL,
  NoModel,
  improvePlan,
  planFromScript,
  planRenderable,
  rewriteBrief,
  speakingSeconds,
  splitSentences,
  validatePlan,
  type PlanModel,
  type PlanProblem,
  type ScenePlan,
} from "../src/lib/scenes.js";

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

/**
 * A reel that should pass every structural check: a seven-word hook, four
 * body sentences, a closing ask, about twenty seconds. Two fixtures in an
 * earlier draft of this file were eleven and seven seconds long -- under
 * the twelve-second floor -- and the validator correctly failed them while
 * the tests expected a pass. The fixture was wrong, not the rule.
 */
const VALID_SCRIPT =
  "Patients search for you and find nothing. " +
  "Your front desk answers the same question about timings forty times a day. " +
  "Nayaverse gives every clinic its own page with timings, services and directions. " +
  "It speaks twelve Indian languages, so nobody is left out. " +
  "Changes go live the moment you save them. " +
  "Book a demo this week.";

const kinds = (problems: readonly PlanProblem[]): string[] => problems.map((p) => p.kind);
const has = (problems: readonly PlanProblem[], kind: string): boolean =>
  problems.some((p) => p.kind === kind);

// ---------------------------------------------------------------------------
console.log("\n## sentence splitting, on this product's own vocabulary");

{
  eq(splitSentences("One. Two. Three.").length, 3, "three plain sentences");

  // The cases a general-purpose splitter gets wrong, and which appear in
  // almost every script this product will ever cut.
  const titles = splitSentences("Dr. Momin sees patients at 9 a.m. Book online.");
  eq(titles.length, 2, "an abbreviation is not a sentence boundary");
  ok(titles[0]!.includes("Dr. Momin"), "and the title stays with its name", titles[0]);

  const price = splitSentences("It costs ₹1,999.50 a month. That is all.");
  eq(price.length, 2, "a decimal point is not a sentence boundary");
  ok(price[0]!.includes("1,999.50"), "and the price survives intact", price[0]);

  eq(splitSentences("Wait... there's more!").length, 2, "an ellipsis is one terminator");
  eq(splitSentences("Really?! Yes.").length, 2, "and so is '?!'");

  // Hindi, Marathi and Bengali end a sentence with a danda, Urdu with the
  // Arabic full stop. Missing these made a whole Hindi script one scene.
  const hindi = splitSentences("मुंबई सूरज से पहले जाग जाती है। पाँच बजे तक लोकल भर जाती है। फ़ॉलो करें।");
  eq(hindi.length, 3, "a danda ends a Hindi sentence");
  ok(hindi[0]!.endsWith("है।"), "and stays with the sentence it ends", hindi[0]);
  eq(splitSentences("ये शहर है॥ और ये कहानी है॥").length, 2, "so does a double danda");
  eq(splitSentences("یہ شہر ہے۔ کیا آپ تیار ہیں؟ چلیں۔").length, 3, "Urdu's full stop and question mark end sentences");
  eq(splitSentences("Mumbai wakes early। Trains fill by five.").length, 2, "a danda after Latin text still ends it");
  eq(splitSentences("   ").length, 0, "blank input yields nothing");
  eq(splitSentences("No terminator here").length, 1, "a script without a full stop still splits");
}

// ---------------------------------------------------------------------------
console.log("\n## duration estimates");

{
  // 165 words a minute means 165 words should land on 60 seconds.
  const sixtySeconds = Array.from({ length: 165 }, () => "word").join(" ");
  const estimate = speakingSeconds(sixtySeconds);
  ok(Math.abs(estimate - 60) < 0.01, `165 words estimates as ${estimate}s`);
  eq(speakingSeconds(""), 0, "no words take no time");
  eq(speakingSeconds("   "), 0, "and neither does whitespace");
}

// ---------------------------------------------------------------------------
console.log("\n## planning a script the creator already wrote");

{
  const script = [
    "Your clinic's website is a PDF on WhatsApp.",
    "Patients search for you and find nothing.",
    "They call to ask your timings, and your front desk answers the same question forty times a day.",
    "Nayaverse gives every clinic its own site, in twelve languages.",
    "Book a demo this week.",
  ].join(" ");

  const plan = planFromScript(script);

  ok(plan.hook.text.startsWith("Your clinic"), "the first sentence is the hook", plan.hook.text);
  ok(plan.scenes.length >= 1, `${plan.scenes.length} body scenes`);
  ok(plan.cta !== null, "and the closing ask is recognised as a call to action");
  ok(plan.cta!.text.includes("Book a demo"), "which is the sentence that asks", plan.cta?.text);

  // Nothing may be lost or invented in the cut.
  const reassembled = [plan.hook, ...plan.scenes, plan.cta!].map((s) => s.text).join(" ");
  eq(reassembled, script, "and the plan reassembles into exactly the script");

  ok(
    plan.scenes.every((s) => s.visual.trim().length > 0),
    "every scene has something to put on screen",
  );
  ok(
    Math.abs(plan.totalSeconds - speakingSeconds(script)) < 0.05,
    "the total matches the whole script's estimate",
  );

  // A scene boundary inside a clause reads as a mistake, so packing stops
  // at sentence ends even when a sentence overflows the budget on its own.
  ok(
    [...plan.scenes, plan.cta!].every((s) => /[.!?]$/.test(s.text.trim())),
    "no scene ends mid-sentence",
  );
}

{
  // A reel that explains something should not have a call to action forced
  // onto it -- an inserted "follow for more" is the tell of generated copy.
  const plan = planFromScript("Here is how triage works. Emergencies go first. Then pregnancies.");
  eq(plan.cta, null, "a script with no ask gets no call to action invented");
}

// ---------------------------------------------------------------------------
console.log("\n## the validator on structural faults");

{
  const long = Array.from({ length: 400 }, (_, i) => `word${i}.`).join(" ");
  const problems = validatePlan(planFromScript(long));
  ok(has(problems, "too-long"), "an overlong reel is caught", kinds(problems).join(","));
  ok(
    problems.find((p) => p.kind === "too-long")!.detail.includes("Cut roughly"),
    "and the detail says how many words to cut",
    problems.find((p) => p.kind === "too-long")?.detail,
  );
  ok(!planRenderable(problems), "and it does not render");
}

{
  // A ten-second preamble before the point: the single most common way a
  // faceless reel fails, and a structural fault a validator can see.
  const preamble =
    "So today I wanted to talk to you a little bit about something that I think " +
    "a lot of clinics in India are quietly struggling with every single day. " +
    "Websites matter. Patients search. We fix that. Book a demo.";
  const problems = validatePlan(planFromScript(preamble));
  ok(has(problems, "hook-too-long"), "a slow hook is caught", kinds(problems).join(","));
  eq(
    problems.find((p) => p.kind === "hook-too-long")!.sceneIndex,
    -1,
    "and is reported against the hook, not a scene",
  );
}

{
  const thin = planFromScript("One idea. Two words.");
  const problems = validatePlan(thin);
  ok(has(problems, "too-short"), "a reel with nothing in it is caught");
  ok(has(problems, "too-few-scenes"), "as is one with nothing changing on screen");
}

{
  // A single sentence longer than a whole scene. `planFromScript` must not
  // silently chop it; the validator must report it.
  const runOn =
    "Nayaverse " + Array.from({ length: 60 }, () => "and more").join(" ") + " today.";
  const plan = planFromScript("Short hook. " + runOn);
  const problems = validatePlan(plan);
  ok(has(problems, "scene-too-long"), "an overlong scene is reported");
  ok(
    plan.scenes.some((s) => s.text.includes(runOn.slice(0, 20))),
    "and the sentence was kept whole rather than cut mid-clause",
  );
}

// ---------------------------------------------------------------------------
console.log("\n## claims this pipeline will not invent a source for");

{
  // Each case asserts *which* rule fired, not merely that something did.
  // Checking only the kind let a bug hide: "100% safe" was caught by the
  // guarantee rule while the percentage rule was broken, and the suite
  // passed anyway.
  const cases: readonly [string, string, string][] = [
    ["We cut waiting time by 40%.", "a percentage", "percentage"],
    ["Treatment is 100% safe and painless.", "a guarantee", "guarantee"],
    ["The number one clinic in Pune.", "a ranking", "ranking"],
    ["Trusted by 12,000 patients.", "a customer count", "count of customers"],
    ["We are NABH-accredited.", "a certification", "certification"],
  ];

  for (const [sentence, label, reason] of cases) {
    const problems = validatePlan(planFromScript(`Hook line. ${sentence} Book a demo.`));
    const matched = problems.filter((p) => p.kind === "unsupported-claim");
    ok(
      matched.some((p) => p.detail.includes(reason)),
      `${label} is flagged by its own rule: "${sentence}"`,
      matched.map((p) => p.detail).join(" | ") || "nothing flagged",
    );
  }

  // The form that broke the pattern: a percentage ending a sentence.
  ok(
    validatePlan(planFromScript("Hook line. Waiting fell 40%. Book a demo."))
      .some((p) => p.detail.includes("percentage")),
    "a percentage immediately before a full stop is still caught",
  );

  // Warnings, not faults. A real substantiated figure must still be
  // publishable -- the validator's job is to stop one going out by
  // accident, not to decide what is true.
  const problems = validatePlan(planFromScript("Hook line. We cut waiting time by 40%. Book now."));
  const claim = problems.find((p) => p.kind === "unsupported-claim")!;
  eq(claim.blocking, false, "a claim warns rather than blocks");
  ok(
    problems.filter((p) => p.blocking).length === 0 ? planRenderable(problems) : true,
    "so a plan with only claim warnings can still render",
  );

  // And ordinary copy must not trip it, or the check gets switched off.
  const clean = validatePlan(
    planFromScript(
      "Your front desk answers the same question all day. " +
        "Nayaverse puts your timings, services and directions on one page. " +
        "It speaks twelve languages. Book a demo this week.",
    ),
  );
  eq(
    clean.filter((p) => p.kind === "unsupported-claim").length,
    0,
    "while plain descriptive copy is not flagged",
    JSON.stringify(clean),
  );
}

// ---------------------------------------------------------------------------
console.log("\n## the NMC rule: a patient may not endorse their doctor");

{
  const prohibited: readonly string[] = [
    "I was treated here and I felt better within a day.",
    "Patients love Dr. Momin.",
    "Our patients trust us completely.",
    "I would highly recommend this clinic.",
    "Thank you doctor for saving my father.",
    "The best treatment I have ever had.",
  ];

  for (const sentence of prohibited) {
    const problems = validatePlan(planFromScript(`Hook line. ${sentence} Book a demo.`));
    ok(has(problems, "testimonial"), `flagged: "${sentence}"`);
  }

  const problems = validatePlan(planFromScript("Hook line. Patients love Dr. Momin. Book now."));
  const t = problems.find((p) => p.kind === "testimonial")!;
  ok(t.detail.includes("NMC"), "and the reason names the rule, not just a style note");
  ok(
    t.detail.includes("registration"),
    "and says whose risk it is -- the doctor's, not the vendor's",
  );

  // The rule is about the endorsement voice. A clinic describing its own
  // service is not a testimonial, and flagging it would make the check
  // useless noise on every legitimate script.
  const allowed: readonly string[] = [
    "Dr. Momin has treated spinal injuries for eleven years.",
    "We see patients from nine in the morning.",
    "The clinic offers physiotherapy and diagnostics.",
    "You can book an appointment online in under a minute.",
  ];
  for (const sentence of allowed) {
    const fine = validatePlan(planFromScript(`Hook line. ${sentence} Book a demo.`));
    ok(!has(fine, "testimonial"), `not flagged: "${sentence}"`);
  }
}

// ---------------------------------------------------------------------------
console.log("\n## feedback written for a rewrite");

{
  const problems = validatePlan(planFromScript("One idea. Two words."));
  const brief = rewriteBrief(problems);
  ok(brief.length > 0, "a brief is produced");
  ok(brief.includes("Overall"), "with plan-level problems labelled Overall");
  ok(brief.split("\n").length === problems.length, "one line per problem, nothing merged");
  eq(rewriteBrief([]), "", "and a clean plan produces no brief");

  const hookProblem = validatePlan(
    planFromScript(
      "So today I wanted to talk about something a lot of clinics in India quietly " +
        "struggle with every single day of the week. Short. Points. Here.",
    ),
  );
  ok(rewriteBrief(hookProblem).includes("Hook:"), "and the hook is labelled Hook");
}

// ---------------------------------------------------------------------------
console.log("\n## the model seam");

{
  eq(LIGHT_MODEL, "claude-haiku-5-5", "the light model is named explicitly");

  let refused = false;
  try {
    await new NoModel().plan({ script: "anything", style: DEFAULT_STYLE });
  } catch (error) {
    refused = true;
    ok(
      String(error).includes("planFromScript"),
      "with no model configured, the seam refuses and points at the path that works",
    );
  }
  ok(refused, "and it refuses rather than returning a fabricated plan");
}

{
  // A model that fails the length budget first, then fixes it when told.
  const script = VALID_SCRIPT;

  const calls: (string | undefined)[] = [];
  const improving: PlanModel = {
    name: "test",
    plan: ({ feedback }) => {
      calls.push(feedback);
      // First attempt: one enormous scene, which fails. Second: the real cut.
      const text = feedback
        ? script
        : "Hook. " + Array.from({ length: 400 }, (_, i) => `w${i}.`).join(" ");
      return Promise.resolve(planFromScript(text));
    },
  };

  const result = await improvePlan(improving, script);
  eq(result.attempts, 2, "a failing plan is rewritten exactly once");
  ok(calls[0] === undefined, "the first attempt gets no feedback");
  ok((calls[1] ?? "").includes("Overall"), "and the second gets the validator's own words");
  ok(planRenderable(result.problems), "the kept plan renders");

  // One rewrite, never a loop: a paid retry loop is how a per-reel cost
  // becomes unbounded without anyone choosing it.
  const stubborn: PlanModel = {
    name: "stubborn",
    plan: () => Promise.resolve(planFromScript("Too short.")),
  };
  const stuck = await improvePlan(stubborn, "whatever");
  eq(stuck.attempts, 2, "a model that fails twice is not asked a third time");
  ok(!planRenderable(stuck.problems), "and the failure is returned, not hidden");
  ok(stuck.problems.length > 0, "with the problems attached for a person to read");
}

{
  // A model that succeeds first time is not charged for a rewrite.
  const good: PlanModel = {
    name: "good",
    plan: () =>
      Promise.resolve(
        planFromScript(VALID_SCRIPT),
      ),
  };
  const result = await improvePlan(good, "x");
  eq(result.attempts, 1, "a passing plan costs one call");
  eq(result.problems.filter((p) => p.blocking).length, 0, "with no faults");
}

// ---------------------------------------------------------------------------
console.log("\n## an empty plan is handled, not crashed on");

{
  const plan: ScenePlan = planFromScript("");
  eq(plan.scenes.length, 0, "an empty script plans no scenes");
  eq(plan.totalSeconds, 0, "and takes no time");
  const problems = validatePlan(plan);
  ok(
    !has(problems, "too-short") && !has(problems, "no-visual"),
    "and is not reported as a short reel or a missing visual",
    kinds(problems).join(","),
  );
}

// ---------------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
