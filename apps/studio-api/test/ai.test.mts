/**
 * The Director's API, against fake writers.
 *
 * No test here calls Anthropic. The real `ClaudePlanModel` is exercised only
 * through what it is built from -- the prompts, which are pure -- and every
 * route is driven with an injected `PlanModel`, so the suite proves the
 * behaviour that matters without a key, a network or a bill:
 *
 *   - `cut` works with no key at all, because it is rules and not a model;
 *   - `write` without a key says so, and says what to do instead;
 *   - a provider failure reaches the creator as a sentence they can act on,
 *     and the provider's own message -- which can name an account balance
 *     or a key -- reaches only the log;
 *   - a testimonial in generated copy is flagged, not published.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA_DIR = mkdtempSync(join(tmpdir(), "studio-ai-test-"));
process.env.NODE_ENV = "test";
process.env.STUDIO_DATA_DIR = DATA_DIR;
process.env.STUDIO_UPLOAD_DIR = join(DATA_DIR, "uploads");
delete process.env.JWT_SECRET;
delete process.env.ANTHROPIC_API_KEY;

const { buildApp } = await import("../src/app.js");
const { AiUnavailable, systemPrompt, userPrompt } = await import("../src/lib/ai.js");
const { DEFAULT_STYLE, planFromScript } = await import("../../studio/src/lib/scenes.js");
type PlanModel = import("../../studio/src/lib/scenes.js").PlanModel;
type PlanRequest = import("../../studio/src/lib/scenes.js").PlanRequest;

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

const VALID_SCRIPT =
  "Patients search for you and find nothing. " +
  "Your front desk answers the same question about timings forty times a day. " +
  "Nayaverse gives every clinic its own page with timings, services and directions. " +
  "It speaks twelve Indian languages, so nobody is left out. " +
  "Changes go live the moment you save them. " +
  "Book a demo this week.";

type App = ReturnType<typeof buildApp>;

async function inject(app: App, method: "GET" | "POST", url: string, token?: string, body?: unknown, ip = "10.1.0.1") {
  const res = await app.inject({
    method,
    url,
    remoteAddress: ip,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: res.statusCode, body: res.body, json: <T,>() => JSON.parse(res.body) as T };
}

let seq = 0;
async function account(app: App, withPlan = true): Promise<string> {
  seq += 1;
  const signup = await inject(app, "POST", "/api/auth/signup", undefined, {
    email: `writer${seq}@example.com`,
    password: "a long enough passphrase",
    name: `Writer ${seq}`,
    region: "IN",
  }, `10.9.${seq}.1`);
  const { token } = signup.json<{ token: string }>();
  if (withPlan) await inject(app, "POST", "/api/account/plan", token, { planId: "creator" });
  return token;
}

/** A writer that records what it was asked and answers from a script. */
function recording(answer: (req: PlanRequest) => string): PlanModel & { calls: PlanRequest[] } {
  const calls: PlanRequest[] = [];
  return {
    name: "fake-writer",
    calls,
    plan: (req) => {
      calls.push(req);
      return Promise.resolve(planFromScript(answer(req), req.style));
    },
  };
}

// ---------------------------------------------------------------------------
console.log("\n## the prompt is generated from the style it is judged by");

{
  const s = systemPrompt(DEFAULT_STYLE);
  const hookWords = Math.floor((DEFAULT_STYLE.maxHookSeconds * DEFAULT_STYLE.wordsPerMinute) / 60);
  ok(s.includes(`at most ${hookWords} words`), `the hook limit is the style's ${DEFAULT_STYLE.maxHookSeconds}s budget (${hookWords} words)`);
  ok(
    s.includes(`Between ${DEFAULT_STYLE.minScenes} and ${DEFAULT_STYLE.maxScenes} body scenes`),
    "the scene count is the validator's own range",
  );
  // A different style must produce a different prompt -- the proof that
  // nothing in it is a literal that could drift from the validator.
  const tighter = systemPrompt({ ...DEFAULT_STYLE, maxHookSeconds: 2, maxScenes: 5 });
  ok(tighter.includes("at most 5 words") && tighter.includes("and 5 body scenes"), "and it changes when the style does");
  ok(/testimonial/i.test(s) && /medical council/i.test(s), "the testimonial rule is stated, with its reason");
  ok(/Never invent a number/.test(s), "and so is the rule against invented numbers");

  const u = userPrompt({
    script: "why clinics need a website",
    style: DEFAULT_STYLE,
    feedback: "- Hook: too long",
    brief: { mode: "write", language: "mr", audience: "clinic owners in Pune", library: ["reception.mp4", "pad.jpg"] },
  });
  ok(u.includes("<brief>") && u.includes("why clinics need a website"), "a write request carries the topic as a brief");
  ok(u.includes("Marathi (mr)"), "the language is named, not just coded");
  ok(u.includes("- reception.mp4") && u.includes("- pad.jpg"), "the creator's file names are offered for visuals");
  ok(u.includes("clinic owners in Pune"), "the audience is passed on");
  ok(u.includes("failed these checks") && u.includes("- Hook: too long"), "and a rewrite carries the validator's feedback");

  const tighten = userPrompt({ script: VALID_SCRIPT, style: DEFAULT_STYLE, brief: { mode: "tighten", language: "en", audience: null, library: [] } });
  ok(tighten.includes("<script>") && tighten.includes("do not add claims"), "a tighten request is told to keep the creator's facts");
  ok(!tighten.includes("uploaded these files"), "and no file list is sent when there are none");
}

// ---------------------------------------------------------------------------
console.log("\n## with no key configured");

{
  const app = buildApp({ worker: false, planModel: null, logger: false });
  await app.ready();

  eq((await inject(app, "GET", "/api/ai/status")).status, 401, "status needs a session");
  const token = await account(app);
  const status = (await inject(app, "GET", "/api/ai/status", token)).json<{ cut: boolean; write: boolean; model: string | null }>();
  eq(status.cut, true, "cutting is always available");
  eq(status.write, false, "writing is reported unavailable, so the editor can say so up front");
  eq(status.model, null, "with no model named");

  const cut = await inject(app, "POST", "/api/ai/plan", token, { mode: "cut", text: VALID_SCRIPT });
  eq(cut.status, 200, "cut works with no key at all");
  const body = cut.json<{ plan: { hook: { text: string }; scenes: { text: string }[]; cta: { text: string } | null }; source: string; renderable: boolean }>();
  eq(body.source, "rules", "and says it came from rules, not a model");
  eq(
    [body.plan.hook.text, ...body.plan.scenes.map((s) => s.text), body.plan.cta?.text].join(" "),
    VALID_SCRIPT,
    "and the plan reassembles into the script exactly",
  );
  eq(body.renderable, true, "a valid script is renderable");

  const write = await inject(app, "POST", "/api/ai/plan", token, { mode: "write", text: "why clinics need a website" });
  eq(write.status, 503, "write without a key is a 503, not a crash");
  const err = write.json<{ error: string; field?: string }>();
  ok(err.error.includes("Cut"), "and the message says what works instead", err.error);
  eq(err.field, "mode", "pointing at the mode control");

  await app.close();
}

// ---------------------------------------------------------------------------
console.log("\n## access and input");

{
  const writer = recording(() => VALID_SCRIPT);
  const app = buildApp({ worker: false, planModel: writer, logger: false });
  await app.ready();

  eq((await inject(app, "POST", "/api/ai/plan", undefined, { mode: "cut", text: VALID_SCRIPT })).status, 401, "a plan needs a session");
  const planless = await account(app, false);
  const refused = await inject(app, "POST", "/api/ai/plan", planless, { mode: "cut", text: VALID_SCRIPT });
  eq(refused.status, 403, "and a chosen plan");

  const token = await account(app);
  const badMode = await inject(app, "POST", "/api/ai/plan", token, { mode: "summon", text: VALID_SCRIPT });
  eq(badMode.status, 400, "an unknown mode is refused");
  eq(badMode.json<{ field?: string }>().field, "mode", "naming the field");
  const tooLong = await inject(app, "POST", "/api/ai/plan", token, { mode: "cut", text: "word ".repeat(1500) });
  eq(tooLong.status, 400, "a paste longer than any reel is refused");
  const tooMany = await inject(app, "POST", "/api/ai/plan", token, {
    mode: "write",
    text: "a topic",
    library: Array.from({ length: 81 }, (_, i) => `f${i}.mp4`),
  });
  eq(tooMany.status, 400, "and so is a library too large to send to a model");
  eq(writer.calls.length, 0, "none of which reached the writer");

  await app.close();
}

// ---------------------------------------------------------------------------
console.log("\n## with a writer");

{
  const writer = recording(() => VALID_SCRIPT);
  const app = buildApp({ worker: false, planModel: writer, logger: false });
  await app.ready();
  const token = await account(app);

  const status = (await inject(app, "GET", "/api/ai/status", token)).json<{ write: boolean; model: string }>();
  eq(status.write, true, "writing is reported available");
  eq(status.model, "fake-writer", "under the writer's own name");

  const res = await inject(app, "POST", "/api/ai/plan", token, {
    mode: "write",
    text: "why clinics need a website",
    language: "hi",
    audience: "single-doctor clinics",
    library: ["reception.mp4"],
  });
  eq(res.status, 200, "a write request succeeds");
  const body = res.json<{ source: string; model: string; attempts: number; renderable: boolean }>();
  eq(body.source, "model", "and says a model wrote it");
  eq(body.attempts, 1, "a plan that passes first time costs one call");
  eq(writer.calls.length, 1, "exactly one");
  const brief = writer.calls[0]!.brief!;
  eq(brief.mode, "write", "the writer is told what kind of help is wanted");
  eq(brief.language, "hi", "in which language");
  eq(brief.audience, "single-doctor clinics", "for whom");
  eq(brief.library[0], "reception.mp4", "and with which files");

  // `cut` never calls the writer, even when one is configured: it is free
  // and it must stay free.
  await inject(app, "POST", "/api/ai/plan", token, { mode: "cut", text: VALID_SCRIPT });
  eq(writer.calls.length, 1, "cut does not spend a model call even when a writer exists");

  await app.close();
}

{
  // A writer that slips a patient testimonial into the copy.
  const writer = recording(() => VALID_SCRIPT.replace("Changes go live the moment you save them.", "Patients love Dr. Momin."));
  const app = buildApp({ worker: false, planModel: writer, logger: false });
  await app.ready();
  const token = await account(app);
  const res = await inject(app, "POST", "/api/ai/plan", token, { mode: "tighten", text: VALID_SCRIPT });
  const body = res.json<{ problems: { kind: string; blocking: boolean }[]; renderable: boolean }>();
  ok(body.problems.some((p) => p.kind === "testimonial"), "a generated testimonial is caught by the same validator");
  ok(body.problems.find((p) => p.kind === "testimonial")?.blocking === false, "as a warning for a person to decide on");
  await app.close();
}

{
  // A writer whose first draft is far too long, and whose rewrite is fine.
  const writer = recording((req) => (req.feedback ? VALID_SCRIPT : "Hook. " + "and more words ".repeat(120) + "end."));
  const app = buildApp({ worker: false, planModel: writer, logger: false });
  await app.ready();
  const token = await account(app);
  const res = await inject(app, "POST", "/api/ai/plan", token, { mode: "write", text: "a topic" });
  const body = res.json<{ attempts: number; renderable: boolean }>();
  eq(body.attempts, 2, "a failing first draft gets exactly one rewrite");
  ok(writer.calls[1]?.feedback?.includes("Overall") ?? false, "fed the validator's own findings");
  eq(writer.calls[1]?.brief?.mode, "write", "with the same brief as the first attempt");
  eq(body.renderable, true, "and the rewrite is what comes back");
  await app.close();
}

// ---------------------------------------------------------------------------
console.log("\n## when the provider fails");

{
  const secret = "Your credit balance is too low to access the Anthropic API (org acct_9f3)";
  const failing: PlanModel = {
    name: "failing",
    plan: () => Promise.reject(new AiUnavailable(429, "AI writing is busy. Try again in a minute.", secret)),
  };
  const app = buildApp({ worker: false, planModel: failing, logger: false });
  await app.ready();
  const token = await account(app);
  const res = await inject(app, "POST", "/api/ai/plan", token, { mode: "write", text: "a topic" });
  eq(res.status, 429, "the provider's status is passed on");
  ok(res.body.includes("Try again in a minute"), "with a sentence the creator can act on");
  ok(!res.body.includes("credit balance") && !res.body.includes("acct_9f3"), "and never the provider's own message");
  await app.close();
}

{
  const broken: PlanModel = { name: "broken", plan: () => Promise.reject(new Error("TypeError at /srv/app/lib/ai.ts:120")) };
  const app = buildApp({ worker: false, planModel: broken, logger: false });
  await app.ready();
  const token = await account(app);
  const res = await inject(app, "POST", "/api/ai/plan", token, { mode: "write", text: "a topic" });
  eq(res.status, 500, "an unexpected failure is a 500");
  ok(!res.body.includes("/srv/app"), "with no path or stack in the body");
  await app.close();
}

// ---------------------------------------------------------------------------
console.log("\n## the rate limit holds");

{
  const app = buildApp({ worker: false, planModel: recording(() => VALID_SCRIPT), aiRateLimitMax: 3, logger: false });
  await app.ready();
  const token = await account(app);
  const statuses: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    statuses.push((await inject(app, "POST", "/api/ai/plan", token, { mode: "cut", text: VALID_SCRIPT }, "10.200.0.1")).status);
  }
  eq(statuses.slice(0, 3).join(","), "200,200,200", "three plans a minute are allowed at a limit of three");
  eq(statuses[3], 429, "and the fourth is throttled, so a stuck client cannot run up a bill");
  await app.close();
}

try {
  rmSync(DATA_DIR, { recursive: true, force: true });
} catch {
  /* Windows holds handles briefly after close */
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
