/**
 * Script to scene plan, and the validator that decides whether it ships.
 *
 * ── The shape of a faceless reel ────────────────────────────────────────
 *
 * Every faceless pipeline surveyed for this module -- open source and
 * commercial alike -- plans the same object before it renders anything: a
 * hook, then five to eight scenes, each one complete idea with a visual to
 * put behind it. Then narration, then alignment (`align.ts`), then cues
 * (`subtitles.ts`), then the render (`filtergraph.ts`).
 *
 * The scene plan is the only stage a model is good at and the only stage a
 * model cannot be trusted with, which is why this module is mostly a
 * validator.
 *
 * ── Why the validator is the valuable half ──────────────────────────────
 *
 * The useful pattern in those pipelines is not "ask a model for scenes". It
 * is: ask, **check deterministically**, and hand the failures back for one
 * rewrite. The checking is where the engineering is, and it has three
 * properties a model does not:
 *
 *   - it runs with no API key, no credits and no network;
 *   - it gives the same answer twice;
 *   - it can refuse.
 *
 * So `validatePlan` is the contract, and generation is a seam behind it.
 * Nothing reaches a render without passing, including a plan a human wrote.
 *
 * ── The claim rules are not a style preference ──────────────────────────
 *
 * Two of the checks exist because of what this product is sold into.
 *
 * India's NMC code prohibits a registered practitioner from soliciting or
 * publishing **patient testimonials**, and the liability lands on the
 * doctor's registration, not on the software vendor. A pipeline that
 * cheerfully generates "patients love Dr Momin!" is a pipeline that gets a
 * customer struck off. The same reasoning covers invented statistics: a
 * fabricated "98% satisfaction" on a medical page is a regulatory problem,
 * not a marketing flourish.
 *
 * These are flagged, not silently rewritten. A creator may have a real,
 * substantiated figure, and quietly deleting their copy would be its own
 * kind of wrong. The validator's job is to make sure nobody publishes one
 * by accident.
 */

export interface Scene {
  /** One complete idea, as it will be narrated. Verbatim script text. */
  readonly text: string;
  /**
   * What to put on screen. A retrieval query, not a prompt: it is matched
   * against the creator's own footage first. See `ASSET_RETRIEVAL` below.
   */
  readonly visual: string;
  /** Estimated seconds of narration, from `speakingSeconds`. */
  readonly seconds: number;
}

export interface ScenePlan {
  /** The first line. Its own field because its budget is its own. */
  readonly hook: Scene;
  readonly scenes: readonly Scene[];
  /** The closing ask. Optional: not every reel should have one. */
  readonly cta: Scene | null;
  readonly totalSeconds: number;
}

export interface PlanStyle {
  /** Words a minute. See `DEFAULT_STYLE` for where the number comes from. */
  readonly wordsPerMinute: number;
  readonly maxTotalSeconds: number;
  readonly minTotalSeconds: number;
  /** The hook has to land before a viewer swipes. */
  readonly maxHookSeconds: number;
  readonly minScenes: number;
  readonly maxScenes: number;
  /** What packing aims for. The cap below is what the validator enforces. */
  readonly targetSceneSeconds: number;
  readonly maxSceneSeconds: number;
  readonly minSceneSeconds: number;
}

/**
 * The defaults, and what each number is actually based on.
 *
 * `wordsPerMinute: 165` -- a narration rate, not a conversational one.
 * Unhurried speech is around 130-150 wpm and short-form narration is read
 * faster. It is an estimate either way, and the honest thing about it is
 * that it is only used to *plan*: once narration exists, real timings come
 * from `align.ts` and this number stops mattering. `scenes.ts` never
 * decides a caption's timing.
 *
 * `maxTotalSeconds: 85` -- short of the platform ceilings rather than at
 * them, because the estimate above has real error in it and a reel that
 * overruns is rejected at upload. The exact per-platform limits change
 * often enough that they belong in configuration, not in this file; this is
 * a safe default, not a claim about Instagram's current maximum.
 *
 * `maxHookSeconds: 3` -- the hook is the retention-critical span and it
 * gets its own budget. A ten-second preamble is the single most common way
 * a faceless reel fails, and it is a structural fault a validator can see.
 *
 * `targetSceneSeconds: 4.5` against `maxSceneSeconds: 14` -- two numbers
 * because they answer two questions. The cap is "how long before a viewer
 * notices nothing has changed", and a plan past it is broken. The target is
 * "where should a cut go when there is a choice". Packing to the cap instead
 * turned a twelve-second script into one twelve-second scene: legal, and
 * exactly the static reel the cap exists to prevent.
 */
export const DEFAULT_STYLE: PlanStyle = {
  wordsPerMinute: 165,
  maxTotalSeconds: 85,
  minTotalSeconds: 12,
  maxHookSeconds: 3,
  minScenes: 3,
  maxScenes: 8,
  targetSceneSeconds: 4.5,
  maxSceneSeconds: 14,
  minSceneSeconds: 1.2,
};

/** How long a line takes to say, at the style's rate. */
export function speakingSeconds(text: string, style: PlanStyle = DEFAULT_STYLE): number {
  const words = text.split(/\s+/).filter((w) => w.length > 0).length;
  if (words === 0) return 0;
  return Number(((words / style.wordsPerMinute) * 60).toFixed(3));
}

// ---------------------------------------------------------------------------
// Segmentation.

/**
 * Split a script into sentences, keeping their punctuation.
 *
 * Deliberately not a sentence tokeniser from a library. The hard cases a
 * real one handles -- "Dr. Momin", "₹1,999", "9 a.m." -- are exactly the
 * tokens in this product's scripts, and an abbreviation list is both small
 * and inspectable. A library that splits "Dr." into its own sentence is
 * worse than no library.
 */
/**
 * Where a sentence can end. Beyond the Latin marks: the danda and double
 * danda that end sentences in Hindi, Marathi, Bengali and other Brahmic
 * scripts, and the Arabic-script full stop and question mark that Urdu
 * uses. Without them a whole Hindi script reads as one sentence, and
 * becomes one scene.
 */
const TERMINATORS = new Set([".", "!", "?", "\n", "।", "॥", "۔", "؟"]);

export function splitSentences(script: string): string[] {
  // Two classes, because they behave differently and conflating them is
  // what makes naive splitters wrong in both directions.
  //
  // A title is always followed by a capitalised word -- that is what a
  // title is for -- so it can never end a sentence. "Dr. Momin" must stay
  // whole no matter what follows.
  const TITLES = new Set(["dr", "mr", "mrs", "ms", "prof", "sr", "jr", "st"]);

  // These can end a sentence or sit inside one, and the only available
  // signal is what comes next: "at 9 a.m. Book online" is two sentences,
  // "at 9 a.m. on Tuesday" is one. A following capital letter decides it.
  //
  // "no" is deliberately absent from both: "No. 4" is rarer in a reel
  // script than a sentence ending in "no.", and treating the latter as an
  // abbreviation silently welds two sentences together.
  const ABBREVIATIONS = new Set([
    "vs", "etc", "approx", "min", "max", "am", "pm", "a.m", "p.m", "i.e", "e.g",
  ]);

  /** The next non-space character, for the capitalisation test above. */
  const nextVisible = (from: number): string => {
    for (let k = from; k < chars.length; k += 1) {
      if (!/\s/.test(chars[k]!)) return chars[k]!;
    }
    return "";
  };

  const out: string[] = [];
  let current = "";

  // Walk the text rather than splitting on a regex, because the decision at
  // each terminator depends on what came before it.
  const chars = [...script.trim()];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    current += ch;
    if (!TERMINATORS.has(ch)) continue;

    // A decimal point or a thousands separator: "₹1,999.50", "version 2.1".
    if (ch === "." && /\d$/.test(current.slice(0, -1)) && /^\d/.test(chars[i + 1] ?? "")) continue;

    const lastWord = current
      .slice(0, -1)
      .split(/\s+/)
      .pop()!
      .toLowerCase()
      .replace(/[^a-z.]/g, "");
    if (ch === "." && TITLES.has(lastWord)) continue;

    // A single letter before a full stop is an initial or the first half of
    // a dotted abbreviation -- "Dr. A. Momin", "9 a.m.", "e.g.". Without
    // this, "a.m." splits at the "a." and the sentence breaks in two, which
    // is how "sees patients at 9 a.m. Book online" became three sentences.
    if (ch === "." && lastWord.length === 1) continue;

    const next = nextVisible(i + 1);
    if (ch === "." && ABBREVIATIONS.has(lastWord) && next !== next.toUpperCase()) continue;

    // An ellipsis is one terminator, not three.
    while (chars[i + 1] !== undefined && chars[i + 1] !== "\n" && TERMINATORS.has(chars[i + 1]!)) {
      current += chars[i + 1];
      i += 1;
    }

    const trimmed = current.trim();
    if (trimmed.length > 0) out.push(trimmed);
    current = "";
  }

  const tail = current.trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

/**
 * Plan scenes from a script, with no model involved.
 *
 * The first sentence is the hook. The rest are packed into scenes up to
 * `maxSceneSeconds`, splitting at sentence boundaries only -- a scene that
 * cuts mid-sentence puts a visual change in the middle of a clause, which
 * reads as a mistake rather than as an edit.
 *
 * This is the baseline, and it is a real answer rather than a placeholder:
 * a creator who has written their script wants it cut, not rewritten.
 * `improvePlan` is for when they want the other thing.
 */
export function planFromScript(
  script: string,
  style: PlanStyle = DEFAULT_STYLE,
  visualFor: (text: string, index: number) => string = defaultVisual,
): ScenePlan {
  const sentences = splitSentences(script);
  if (sentences.length === 0) {
    const empty: Scene = { text: "", visual: "", seconds: 0 };
    return { hook: empty, scenes: [], cta: null, totalSeconds: 0 };
  }

  const scene = (text: string, index: number): Scene => ({
    text,
    visual: visualFor(text, index),
    seconds: speakingSeconds(text, style),
  });

  const hook = scene(sentences[0]!, 0);
  const rest = sentences.slice(1);

  // The call to action is taken off the end as a *sentence*, before any
  // packing. Detecting it afterwards, on a packed scene, pulled every
  // sentence packed alongside it out of the body too -- so a short script
  // lost its whole middle to the CTA. Detected rather than required: a reel
  // that explains something does not need to end by asking for a follow,
  // and inserting one is the tell of generated content.
  const ctaText = rest.length > 0 && CTA_PATTERN.test(rest[rest.length - 1]!) ? rest.pop()! : null;

  const body: Scene[] = [];
  let buffer: string[] = [];

  const flush = (): void => {
    if (buffer.length === 0) return;
    body.push(scene(buffer.join(" "), body.length + 1));
    buffer = [];
  };

  for (const sentence of rest) {
    const candidate = [...buffer, sentence].join(" ");
    // Pack towards the target, never past the cap. A sentence longer than a
    // whole scene becomes its own, overlong scene -- and the validator
    // reports it, rather than this function silently chopping a clause in
    // half to satisfy a budget.
    const over =
      speakingSeconds(candidate, style) > style.targetSceneSeconds ||
      speakingSeconds(candidate, style) > style.maxSceneSeconds;
    if (buffer.length > 0 && over) {
      flush();
      buffer = [sentence];
      continue;
    }
    buffer.push(sentence);
  }
  flush();

  const cta = ctaText === null ? null : scene(ctaText, body.length + 1);
  const all = [hook, ...body, ...(cta ? [cta] : [])];
  return {
    hook,
    scenes: body,
    cta,
    totalSeconds: Number(all.reduce((sum, s) => sum + s.seconds, 0).toFixed(3)),
  };
}

const CTA_PATTERN =
  /\b(follow|subscribe|comment|link in bio|dm|book (a|an|your|now|today)|try it|get started|sign up|save this|share this)\b/i;

/**
 * The fallback visual query: the scene's own content words.
 *
 * Stopwords out, longest words first, three kept. Crude, and deliberately
 * so -- it is a retrieval query against the creator's own library, where
 * "clinic reception waiting" finds the right clip and a cinematic prompt
 * paragraph finds nothing. A model can do better and `improvePlan` is where
 * it gets the chance.
 */
function defaultVisual(text: string): string {
  const STOPWORDS = new Set([
    "the", "a", "an", "and", "or", "but", "if", "then", "that", "this", "these",
    "those", "is", "are", "was", "were", "be", "been", "being", "to", "of", "in",
    "on", "for", "with", "at", "by", "from", "up", "about", "into", "it", "its",
    "you", "your", "we", "our", "they", "their", "i", "my", "me", "so", "no",
    "not", "do", "does", "did", "have", "has", "had", "will", "would", "can",
    "could", "should", "all", "any", "more", "most", "just", "now", "here",
  ]);
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
    ),
  ]
    .sort((a, b) => b.length - a.length)
    .slice(0, 3)
    .join(" ");
}

// ---------------------------------------------------------------------------
// The validator.

export type ProblemKind =
  | "too-long"
  | "too-short"
  | "hook-too-long"
  | "too-few-scenes"
  | "too-many-scenes"
  | "scene-too-long"
  | "scene-too-short"
  | "no-visual"
  | "unsupported-claim"
  | "testimonial";

export interface PlanProblem {
  readonly kind: ProblemKind;
  /** Which scene, or null for the plan as a whole. `-1` is the hook. */
  readonly sceneIndex: number | null;
  /** Written to be handed to a model as rewrite feedback, and to a person. */
  readonly detail: string;
  /**
   * `true` when the plan must not render. A claim problem is a warning: it
   * needs a human to confirm the claim is substantiated, and this module
   * cannot know whether it is.
   */
  readonly blocking: boolean;
}

/**
 * Phrases that assert something this pipeline cannot substantiate.
 *
 * Matched on the narration text, not the visual query. Each entry is a
 * pattern a generated script reaches for and a regulator reads as a claim:
 * superlatives, invented numbers, and guarantees.
 */
const CLAIM_PATTERNS: readonly { readonly re: RegExp; readonly why: string }[] = [
  {
    // No trailing `\b` after the alternation: `%` is not a word character,
    // so `%\b` requires a word character after it and fails on the far
    // commonest form of all -- "by 40%." at the end of a sentence. The
    // boundary belongs inside the spelled-out alternatives only.
    re: /\b\d{1,3}(\.\d+)?\s*(%|per\s?cent\b|percent\b)/i,
    why: "a percentage, which has to come from somewhere real",
  },
  {
    re: /\b(guaranteed|guarantee|100%\s*(safe|effective|cure)|cures?\b|painless)\b/i,
    why: "a guarantee of outcome",
  },
  {
    re: /\b(number\s?one|no\.?\s?1|#1|best\s+(in|clinic|doctor|hospital)|top\s+rated|award[-\s]?winning)\b/i,
    why: "a ranking or award claim",
  },
  {
    re: /\b(\d[\d,]{2,})\s*(\+)?\s*(patients|customers|clients|users|doctors|clinics)\b/i,
    why: "a count of customers",
  },
  {
    re: /\b(certified|accredited|iso\s?\d+|nabh[-\s]?accredited)\b/i,
    why: "a certification claim",
  },
];

/**
 * Phrasing that reads as a patient speaking about their care.
 *
 * This is the NMC rule, and it is narrower than it looks: a doctor
 * describing their own service is fine, a patient endorsing it is not. The
 * patterns look for the endorsement voice -- first person about treatment,
 * or third person reporting praise.
 */
const TESTIMONIAL_PATTERNS: readonly RegExp[] = [
  /\b(i|my)\s+(was|got|had|felt)\s+[^.!?]{0,40}\b(treated|cured|better|relief|healed|operated)\b/i,
  /\b(patients?|people)\s+(love|trust|recommend|praise|swear by)\b/i,
  /\b(highly|strongly)\s+recommend(ed)?\b/i,
  /\b(thank(s| you)?|grateful|saved my)\s+[^.!?]{0,30}\b(doctor|dr\.?|clinic|hospital)\b/i,
  /\b(best|amazing|wonderful|excellent)\s+(doctor|experience|treatment|care)\b/i,
];

/**
 * Check a plan. The same function for a generated plan and a typed one.
 *
 * Returns every problem rather than the first, because the whole point of
 * the pattern this implements is to hand a model all of its mistakes at
 * once. One problem per rewrite is a conversation; all of them is a fix.
 */
export function validatePlan(plan: ScenePlan, style: PlanStyle = DEFAULT_STYLE): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const all = [plan.hook, ...plan.scenes, ...(plan.cta ? [plan.cta] : [])];

  const add = (
    kind: ProblemKind,
    sceneIndex: number | null,
    detail: string,
    blocking = true,
  ): void => {
    problems.push({ kind, sceneIndex, detail, blocking });
  };

  if (plan.totalSeconds > style.maxTotalSeconds) {
    add(
      "too-long",
      null,
      `The reel runs about ${plan.totalSeconds.toFixed(1)}s against a ${style.maxTotalSeconds}s ` +
        `budget. Cut roughly ${Math.ceil(
          ((plan.totalSeconds - style.maxTotalSeconds) / 60) * style.wordsPerMinute,
        )} words.`,
    );
  }
  if (plan.totalSeconds > 0 && plan.totalSeconds < style.minTotalSeconds) {
    add(
      "too-short",
      null,
      `The reel runs about ${plan.totalSeconds.toFixed(1)}s, under the ${style.minTotalSeconds}s ` +
        `floor. There is not enough here to hold a viewer.`,
    );
  }
  if (plan.hook.seconds > style.maxHookSeconds) {
    add(
      "hook-too-long",
      -1,
      `The hook takes about ${plan.hook.seconds.toFixed(1)}s and has ` +
        `${style.maxHookSeconds}s. Lead with the claim, not the context.`,
    );
  }
  if (plan.scenes.length < style.minScenes) {
    add(
      "too-few-scenes",
      null,
      `${plan.scenes.length} scenes after the hook, against a minimum of ${style.minScenes}. ` +
        `Nothing changes on screen for long stretches.`,
    );
  }
  if (plan.scenes.length > style.maxScenes) {
    add(
      "too-many-scenes",
      null,
      `${plan.scenes.length} scenes after the hook, against a maximum of ${style.maxScenes}.`,
    );
  }

  all.forEach((scene, i) => {
    // -1 for the hook, then 0-based for the body, so a caller can point at
    // the right thing without knowing how this function flattened the plan.
    const index = i === 0 ? -1 : i - 1;

    if (scene.seconds > style.maxSceneSeconds) {
      add(
        "scene-too-long",
        index,
        `Scene runs about ${scene.seconds.toFixed(1)}s against ${style.maxSceneSeconds}s. ` +
          `Split it, or shorten it to one idea.`,
      );
    }
    if (scene.seconds > 0 && scene.seconds < style.minSceneSeconds) {
      add(
        "scene-too-short",
        index,
        `Scene runs about ${scene.seconds.toFixed(1)}s. A visual that appears for less than ` +
          `${style.minSceneSeconds}s reads as a glitch.`,
      );
    }
    if (scene.text.trim().length > 0 && scene.visual.trim().length === 0) {
      add("no-visual", index, "Scene has narration but nothing to put on screen.");
    }

    for (const { re, why } of CLAIM_PATTERNS) {
      const hit = re.exec(scene.text);
      if (hit) {
        add(
          "unsupported-claim",
          index,
          `"${hit[0]}" is ${why}. Confirm it is substantiated, or cut it -- this pipeline ` +
            `will not invent a source for it.`,
          false,
        );
      }
    }
    for (const re of TESTIMONIAL_PATTERNS) {
      const hit = re.exec(scene.text);
      if (hit) {
        add(
          "testimonial",
          index,
          `"${hit[0]}" reads as a patient endorsement. India's NMC code prohibits a ` +
            `practitioner from publishing patient testimonials, and the risk is to their ` +
            `registration. Rewrite it as something the clinic says about itself.`,
          false,
        );
      }
    }
  });

  return problems;
}

/** Whether a plan may be rendered. Warnings do not block; faults do. */
export const planRenderable = (problems: readonly PlanProblem[]): boolean =>
  !problems.some((p) => p.blocking);

/**
 * The failures, written for a model to act on.
 *
 * One line each, in plan order, with no scores or JSON. The rewrite prompt
 * is the problem list because the problem list already says what is wrong
 * and by how much -- which is the advantage of having measured it rather
 * than asked about it.
 */
export function rewriteBrief(problems: readonly PlanProblem[]): string {
  if (problems.length === 0) return "";
  const where = (p: PlanProblem): string =>
    p.sceneIndex === null ? "Overall" : p.sceneIndex === -1 ? "Hook" : `Scene ${p.sceneIndex + 1}`;
  return problems.map((p) => `- ${where(p)}: ${p.detail}`).join("\n");
}

// ---------------------------------------------------------------------------
// The model seam.

/**
 * Where a language model is allowed to touch a reel, and which one.
 *
 * ── Light models, on purpose ────────────────────────────────────────────
 *
 * Every job here is short-input, short-output and structurally constrained:
 * cut a paragraph into scenes, tighten a hook to three seconds, name a
 * visual. That is Haiku-class work. Reaching for a frontier model would
 * multiply the cost of the one operation a creator performs dozens of times
 * a day and improve nothing a validator can measure -- and the validator is
 * what decides whether the output ships, so an unmeasurable improvement is
 * not an improvement.
 *
 * ── The seam refuses rather than pretends ───────────────────────────────
 *
 * `NoModel` is the default implementation and it throws. It does not return
 * the input unchanged pretending to have improved it, and it does not
 * invent a plan. The same position `dubbing.ts` takes about dub providers,
 * for the same reason: a fake result is worse than an error, because an
 * error is actionable.
 */
export const LIGHT_MODEL = "claude-haiku-5-5";

export interface PlanRequest {
  /** The creator's script, or for `write`, their topic. */
  readonly script: string;
  readonly style: PlanStyle;
  /** Present on a rewrite: what the validator said about the last attempt. */
  readonly feedback?: string;
  /** What kind of help is wanted. Absent means "cut this as it stands". */
  readonly brief?: PlanBrief;
}

/**
 * The context a model gets beyond the text itself.
 *
 * `library` is the one that changes the output most. A model choosing a
 * visual with no idea what footage exists writes "doctor smiling at
 * patient" for a creator whose library is `reception.mp4` and
 * `prescription-pad.jpg`; told the file names, it writes queries the
 * director can actually satisfy. The names go to the model and nothing
 * else about the files does.
 */
export interface PlanBrief {
  /** `write` drafts from a topic; `tighten` edits the creator's own script. */
  readonly mode: 'write' | 'tighten';
  /** BCP 47, as the editor's language picker sends it. */
  readonly language: string;
  readonly audience: string | null;
  readonly library: readonly string[];
}

export interface PlanModel {
  readonly name: string;
  plan(request: PlanRequest): Promise<ScenePlan>;
}

export class NoModel implements PlanModel {
  readonly name = "none";
  plan(): Promise<ScenePlan> {
    return Promise.reject(
      new Error(
        "No script model is configured, so a plan cannot be generated. " +
          "`planFromScript` cuts a script the creator has already written, with no model " +
          "at all, and `validatePlan` checks it. Set a provider to generate one.",
      ),
    );
  }
}

/**
 * Generate, validate, and allow exactly one rewrite.
 *
 * One, not a loop. A model that failed the same measurable constraint twice
 * is not going to succeed on the fifth attempt, and a retry loop against a
 * paid API is how a per-reel cost becomes unbounded without anyone
 * choosing it. After the second attempt the better plan of the two is
 * returned **with its problems**, for a person to decide about.
 */
export async function improvePlan(
  model: PlanModel,
  script: string,
  style: PlanStyle = DEFAULT_STYLE,
  brief?: PlanBrief,
): Promise<{ plan: ScenePlan; problems: PlanProblem[]; attempts: number }> {
  const withBrief = brief ? { brief } : {};
  const first = await model.plan({ script, style, ...withBrief });
  const firstProblems = validatePlan(first, style);
  if (planRenderable(firstProblems)) {
    return { plan: first, problems: firstProblems, attempts: 1 };
  }

  const second = await model.plan({
    script,
    style,
    ...withBrief,
    feedback: rewriteBrief(firstProblems.filter((p) => p.blocking)),
  });
  const secondProblems = validatePlan(second, style);

  // Count only faults when choosing: a plan with fewer blocking problems is
  // better even if it collected more warnings, because warnings are for a
  // person and faults stop the render.
  const faults = (ps: readonly PlanProblem[]): number => ps.filter((p) => p.blocking).length;
  const keepSecond = faults(secondProblems) <= faults(firstProblems);
  return {
    plan: keepSecond ? second : first,
    problems: keepSecond ? secondProblems : firstProblems,
    attempts: 2,
  };
}

/**
 * How a scene's visual is found, and why there is no vector store here yet.
 *
 * A scene's `visual` is a retrieval query. The right thing to run it
 * against, in order:
 *
 *   1. **The creator's own footage.** Already uploaded, already theirs,
 *      already cleared for use. Matched on filename, folder, caption and
 *      any tags -- which is keyword retrieval over a library of tens to
 *      hundreds of clips, where keyword retrieval is not the weak option.
 *   2. A stock library, if one is licensed.
 *   3. Generated imagery, which is the expensive and least trustworthy
 *      option and belongs last.
 *
 * A central vector index is the right answer at step 1 once a library is
 * large enough that keywords miss -- and once there is an embedding model
 * wired up to build it. Adding an empty vector store before either is true
 * would be infrastructure with nothing in it: the retrieval quality would
 * come from the embedding provider that does not exist yet, not from the
 * index. So the interface below is the seam, and the decision about what
 * sits behind it is deliberately still open.
 */
export interface AssetQuery {
  readonly visual: string;
  readonly limit: number;
}

export interface AssetMatch {
  readonly id: string;
  /** 0..1. Comparable only within one retriever. */
  readonly score: number;
  readonly why: string;
}

export interface AssetRetriever {
  readonly name: string;
  find(query: AssetQuery): Promise<AssetMatch[]>;
}

export const ASSET_RETRIEVAL = {
  /** Nothing is on screen until something is retrieved or uploaded. */
  requiredForRender: true,
  /** Set when a retriever is wired. Until then, every scene needs an asset
   *  chosen by hand, and the editor says so rather than rendering black. */
  configured: false,
} as const;
