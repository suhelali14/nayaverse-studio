/**
 * The whole API, driven end to end against a throwaway store.
 *
 * ── What is real here and what is not ────────────────────────────────
 *
 * Everything except the provider. Fastify, the routes, the zod schemas,
 * bcrypt at cost 12, real JWTs, the rate limiter, the multipart parser,
 * the atomic file store and the job worker all run for real. The one
 * stubbed thing is the ASR/dub/render provider, which does not exist --
 * see `src/lib/worker.ts`.
 *
 * `app.inject()` rather than a listening socket: it exercises the same
 * handler chain, including hooks and the error handler, without a port
 * this repo's other apps might be using.
 *
 * The store is a fresh temp directory per run, and the env is set before
 * the first import because `src/config/env.ts` parses `process.env` at
 * module load. That ordering is load-bearing -- an `import` moved above
 * these lines would point the suite at the development store.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA_DIR = mkdtempSync(join(tmpdir(), "studio-api-test-"));

process.env.NODE_ENV = "test";
process.env.STUDIO_DATA_DIR = DATA_DIR;
process.env.STUDIO_UPLOAD_DIR = join(DATA_DIR, "uploads");
process.env.STUDIO_SIMULATE_JOBS = "true";
// Short enough that waiting on a job is not the slowest part of the suite,
// long enough that `queued` and `running` are both observable.
process.env.STUDIO_SIMULATE_MS = "120";
process.env.STUDIO_WORKER_POLL_MS = "20";
delete process.env.JWT_SECRET;

const { buildApp, AUTH_RATE_LIMIT_PER_MINUTE } = await import("../src/app.js");
const { DUB_OVERAGE_PER_MINUTE, PLANS } = await import("../src/config/plans.js");
const store = await import("../src/lib/store.js");

// ---------------------------------------------------------------------------
// Harness.

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
  ok(
    actual === expected,
    what,
    actual === expected ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );

const section = (title: string): void => console.log(`\n${title}`);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// ---------------------------------------------------------------------------
// The app, and a recording client.

/**
 * Built with the real rate limits.
 *
 * Nothing is raised for the suite's convenience: the limiter is one of the
 * things being tested, and a suite that turns it off would pass against a
 * build that had no limiter at all -- which is exactly the bug this file
 * caught once already. The per-IP keying is what makes that affordable:
 * each account below signs in from its own address, as separate people
 * would.
 */
const app = buildApp({ logger: false });
await app.ready();

/**
 * Every response body the suite has seen.
 *
 * Collected so the leak check at the end is over the whole run rather
 * than over the handful of endpoints somebody thought to check. A field
 * added to a mapper six months from now gets scanned by this without
 * anybody adding a test.
 */
const seen: Array<{ method: string; path: string; status: number; body: string }> = [];

interface CallOptions {
  token?: string | undefined;
  body?: unknown;
  /** Raw payload, for the multipart cases. */
  payload?: Buffer;
  contentType?: string;
  /** Rate limiting is per IP, so each account gets its own. */
  ip?: string;
}

interface Result {
  status: number;
  body: string;
  json: <T>() => T;
}

async function call(
  method: "GET" | "POST" | "DELETE",
  path: string,
  options: CallOptions = {},
): Promise<Result> {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.contentType) headers["content-type"] = options.contentType;

  const response = await app.inject({
    method,
    url: path,
    headers,
    remoteAddress: options.ip ?? "127.0.0.1",
    ...(options.payload ? { payload: options.payload } : {}),
    ...(options.body !== undefined ? { payload: options.body as object } : {}),
  });

  seen.push({ method, path, status: response.statusCode, body: response.body });
  return {
    status: response.statusCode,
    body: response.body,
    json: <T,>() => JSON.parse(response.body) as T,
  };
}

/**
 * A multipart body, built by hand.
 *
 * Fields come before the file deliberately: `request.file()` resolves when
 * the file part arrives, so only the fields parsed before it are in
 * `file.fields`. Anything the server needs alongside the upload has to be
 * sent first, and a test that sent it after would pass for the wrong
 * reason.
 */
function multipart(
  fields: Record<string, string>,
  file: { filename: string; contentType: string; data: Buffer } | null,
): { payload: Buffer; contentType: string } {
  const boundary = "----studiotest9f2c1b";
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
          `Content-Type: ${file.contentType}\r\n\r\n`,
      ),
      file.data,
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

interface Job {
  id: string;
  projectId: string;
  kind: string;
  status: string;
  progress: number | null;
  message: string | null;
  simulated: boolean;
  language?: string;
}

async function waitForJob(
  token: string,
  ip: string,
  projectId: string,
  jobId: string,
  want: string,
  timeoutMs = 6000,
): Promise<Job | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await call("GET", `/api/jobs?projectId=${projectId}`, { token, ip });
    const job = response.json<Job[]>().find((j) => j.id === jobId);
    if (job && job.status === want) return job;
    if (job && (job.status === "done" || job.status === "failed")) return job;
    await sleep(25);
  }
  return null;
}

interface Account {
  id: string;
  email: string;
  name: string;
  planId: string | null;
  region: string;
  createdAt: string;
}
interface Project {
  id: string;
  title: string;
  status: string;
  language: string;
  seconds: number;
  updatedAt: string;
  thumbnailUrl: string | null;
  videoUrl: string | null;
  hasSubtitles: boolean;
  dubbedInto: string[];
}
interface Usage {
  periodStart: string;
  periodEnd: string;
  reelsUsed: number;
  reelsIncluded: number;
  dubSecondsUsed: number;
  dubSecondsIncluded: number;
  overageDue: number;
}

/** The passwords used in this run, so the leak check can look for them. */
const SECRETS = ["correct-horse-battery", "a-different-long-password", "third-account-secret"];

const FAKE_MP4 = Buffer.from("not-really-an-mp4-but-the-parser-does-not-care", "utf8");

// ===========================================================================

section("signup, login and me round trip");

const ipA = "10.0.0.1";
let tokenA = "";
let accountA: Account;
{
  const signup = await call("POST", "/api/auth/signup", {
    ip: ipA,
    body: {
      // Mixed case and padding on purpose: both have to be normalised away
      // or the login below cannot find this account.
      email: "  Asha@Example.COM ",
      password: SECRETS[0],
      name: "Asha",
      region: "IN",
    },
  });
  eq(signup.status, 201, "signup answers 201");
  const created = signup.json<{ token: string; account: Account }>();
  tokenA = created.token;
  accountA = created.account;
  eq(created.account.email, "asha@example.com", "the email is trimmed and lower-cased");
  eq(created.account.planId, null, "a new account has no plan");
  eq(created.account.region, "IN", "the region is kept");
  ok(created.token.split(".").length === 3, "a JWT comes back");

  const login = await call("POST", "/api/auth/login", {
    ip: ipA,
    // A different case again, and no padding. Same account.
    body: { email: "ASHA@example.com", password: SECRETS[0] },
  });
  eq(login.status, 200, "login answers 200");
  const loggedIn = login.json<{ token: string; account: Account }>();
  eq(loggedIn.account.id, accountA.id, "login finds the account whatever the case");

  const me = await call("GET", "/api/auth/me", { token: loggedIn.token, ip: ipA });
  eq(me.status, 200, "me answers 200 with a token");
  eq(me.json<Account>().id, accountA.id, "me is the same account");
}

section("a duplicate signup is refused, and says which field");
{
  const again = await call("POST", "/api/auth/signup", {
    ip: ipA,
    body: { email: "ASHA@EXAMPLE.com", password: SECRETS[1], name: "Someone Else", region: "WORLD" },
  });
  eq(again.status, 409, "a second signup on that address is 409");
  const body = again.json<{ error: string; field?: string }>();
  eq(body.field, "email", "the refusal names the email field");
  ok(/already registered/i.test(body.error), "and says why", body.error);
}

section("a wrong password and an unknown email are indistinguishable");
{
  const wrongPassword = await call("POST", "/api/auth/login", {
    ip: ipA,
    body: { email: "asha@example.com", password: "not-the-right-password" },
  });
  const unknownEmail = await call("POST", "/api/auth/login", {
    ip: ipA,
    body: { email: "nobody-at-all@example.com", password: "not-the-right-password" },
  });
  eq(wrongPassword.status, 401, "a wrong password is 401");
  eq(unknownEmail.status, 401, "an unknown email is 401");
  eq(unknownEmail.body, wrongPassword.body, "byte for byte the same response body");

  // A malformed address takes the same path, rather than being a 400 that
  // tells a prober their guess was not even a candidate.
  const malformed = await call("POST", "/api/auth/login", {
    ip: ipA,
    body: { email: "not-an-email", password: "whatever-at-all" },
  });
  eq(malformed.status, 401, "a malformed email is also 401, not 400");
}

section("logout actually kills the token");
{
  // From a second address, as a second browser would be: the point is two
  // live tokens for one account, and it keeps ipA clear of the real
  // ten-a-minute login limit this suite deliberately runs against.
  const spare = await call("POST", "/api/auth/login", {
    ip: "10.0.0.21",
    body: { email: "asha@example.com", password: SECRETS[0] },
  });
  const spareToken = spare.json<{ token: string }>().token;
  eq((await call("GET", "/api/auth/me", { token: spareToken, ip: ipA })).status, 200, "the token works");

  const out = await call("POST", "/api/auth/logout", { token: spareToken, ip: ipA });
  eq(out.status, 204, "logout answers 204");
  eq(out.body, "", "with no body");
  eq(
    (await call("GET", "/api/auth/me", { token: spareToken, ip: ipA })).status,
    401,
    "and the same token is refused afterwards",
  );
  // tokenA is a different token and must be unaffected -- signing out of
  // one browser does not sign you out of the other.
  eq((await call("GET", "/api/auth/me", { token: tokenA, ip: ipA })).status, 200, "other tokens survive");

  /**
   * And the shape the real client actually produces.
   *
   * `api.logOut()` clears its token before it calls this, so the request
   * arrives with no Authorization header and there is nothing to revoke
   * -- see the note on the route. Asserted rather than left implicit: the
   * 204 is correct, and the gap it leaves is a one-line fix on the client
   * that this test will go on documenting until somebody makes it.
   */
  const headerless = await call("POST", "/api/auth/logout", { ip: "10.0.0.22" });
  eq(headerless.status, 204, "a logout with no token is still 204, as the client sends it");
}

section("no token is 401 everywhere that needs one");
{
  const protectedRoutes: Array<["GET" | "POST" | "DELETE", string]> = [
    ["GET", "/api/auth/me"],
    ["POST", "/api/account/plan"],
    ["GET", "/api/account/usage"],
    ["GET", "/api/projects"],
    ["POST", "/api/projects"],
    ["GET", "/api/projects/prj_whatever"],
    ["DELETE", "/api/projects/prj_whatever"],
    ["POST", "/api/projects/prj_whatever/footage"],
    ["POST", "/api/projects/prj_whatever/transcribe"],
    ["GET", "/api/projects/prj_whatever/transcript"],
    ["POST", "/api/projects/prj_whatever/dub"],
    ["POST", "/api/projects/prj_whatever/render"],
    ["GET", "/api/jobs"],
  ];
  let allRefused = true;
  const offenders: string[] = [];
  for (const [method, path] of protectedRoutes) {
    const response = await call(method, path, { ip: "10.9.9.9", body: {} });
    if (response.status !== 401) {
      allRefused = false;
      offenders.push(`${method} ${path} -> ${response.status}`);
    }
  }
  ok(allRefused, `all ${protectedRoutes.length} protected routes answer 401 without a token`, offenders.join("; "));

  const forged = await call("GET", "/api/auth/me", {
    ip: "10.9.9.9",
    token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhY2NfZmFrZSIsImp0aSI6ImZha2UifQ.not-a-real-signature",
  });
  eq(forged.status, 401, "a forged token is 401");
}

section("nothing metered happens before a plan is chosen");
{
  const tooEarly = await call("POST", "/api/projects", {
    token: tokenA,
    ip: ipA,
    body: { title: "First reel", language: "hi" },
  });
  eq(tooEarly.status, 403, "creating a project without a plan is 403");
  ok(/choose a plan/i.test(tooEarly.json<{ error: string }>().error), "and says to choose a plan");

  const usageBefore = await call("GET", "/api/account/usage", { token: tokenA, ip: ipA });
  eq(usageBefore.status, 200, "usage still answers without a plan");
  eq(usageBefore.json<Usage>().reelsIncluded, 0, "and reports an allowance of zero");
}

section("choosing a plan unlocks the account, and usage reflects it");
{
  const bad = await call("POST", "/api/account/plan", {
    token: tokenA,
    ip: ipA,
    body: { planId: "enterprise" },
  });
  eq(bad.status, 400, "an unknown plan id is 400");
  eq(bad.json<{ field?: string }>().field, "planId", "and names the planId field");

  const chosen = await call("POST", "/api/account/plan", {
    token: tokenA,
    ip: ipA,
    body: { planId: "starter" },
  });
  eq(chosen.status, 200, "choosing starter answers 200");
  eq(chosen.json<Account>().planId, "starter", "and the account carries the plan");

  const usage = await call("GET", "/api/account/usage", { token: tokenA, ip: ipA });
  const u = usage.json<Usage>();
  eq(u.reelsIncluded, 15, "usage now reports Starter's 15 reels");
  eq(u.reelsUsed, 0, "none used yet");
  eq(u.dubSecondsIncluded, 0, "and no dubbing included");
  eq(u.overageDue, 0, "nothing owed");
  ok(u.periodStart < u.periodEnd, "the billing period runs forwards", `${u.periodStart} .. ${u.periodEnd}`);
}

section("creating a project spends a reel");
let projectA: Project;
{
  const created = await call("POST", "/api/projects", {
    token: tokenA,
    ip: ipA,
    body: { title: "Why the quiet hour is the useful one", language: "hi" },
  });
  eq(created.status, 201, "creating a project answers 201");
  projectA = created.json<Project>();
  eq(projectA.status, "draft", "it starts as a draft");
  eq(projectA.seconds, 0, "with no footage and no duration");
  eq(projectA.videoUrl, null, "and nothing rendered");

  const usage = await call("GET", "/api/account/usage", { token: tokenA, ip: ipA });
  eq(usage.json<Usage>().reelsUsed, 1, "usage counts one reel used");

  const list = await call("GET", "/api/projects", { token: tokenA, ip: ipA });
  eq(list.json<Project[]>().length, 1, "it is in the list");

  const fetched = await call("GET", `/api/projects/${projectA.id}`, { token: tokenA, ip: ipA });
  eq(fetched.status, 200, "and readable by id");
  eq(fetched.json<Project>().id, projectA.id, "the same project");

  const empty = await call("POST", "/api/projects", {
    token: tokenA,
    ip: ipA,
    body: { title: "   ", language: "hi" },
  });
  eq(empty.status, 400, "a blank title is 400");
  eq(empty.json<{ field?: string }>().field, "title", "and names the title field");
}

section("deleting a project does NOT give the reel back");
{
  const throwaway = await call("POST", "/api/projects", {
    token: tokenA,
    ip: ipA,
    body: { title: "Deleted on purpose", language: "hi" },
  });
  const id = throwaway.json<Project>().id;
  const deleted = await call("DELETE", `/api/projects/${id}`, { token: tokenA, ip: ipA });
  eq(deleted.status, 204, "delete answers 204");
  eq(
    (await call("GET", `/api/projects/${id}`, { token: tokenA, ip: ipA })).status,
    404,
    "and it is gone",
  );
  eq(
    (await call("GET", "/api/account/usage", { token: tokenA, ip: ipA })).json<Usage>().reelsUsed,
    2,
    "usage still counts both reels -- the cap is not resettable by deleting",
  );
}

section("footage upload");
{
  const good = multipart({ seconds: "30" }, {
    // A filename that would escape the upload directory if it were ever
    // used. It must not be: the stored name is generated.
    filename: "../../../../evil.mp4",
    contentType: "video/mp4",
    data: FAKE_MP4,
  });
  const uploaded = await call("POST", `/api/projects/${projectA.id}/footage`, {
    token: tokenA,
    ip: ipA,
    payload: good.payload,
    contentType: good.contentType,
  });
  eq(uploaded.status, 200, "uploading footage answers 200");
  const withFootage = uploaded.json<Project>();
  eq(withFootage.status, "editing", "the project moves from draft to editing");
  eq(withFootage.seconds, 30, "the reported duration is kept");

  const stored = readdirSync(join(DATA_DIR, "uploads"));
  eq(stored.length, 1, "exactly one file landed on disk");
  ok(
    stored.every((name) => !name.includes("evil") && !name.includes("..")),
    "and the client's filename was not used for it",
    stored.join(", "),
  );
  ok(/^[0-9a-f-]{36}\.mp4$/.test(stored[0] ?? ""), "the stored name is a generated uuid", stored[0]);

  const wrongType = multipart({}, {
    filename: "payload.html",
    contentType: "text/html",
    data: Buffer.from("<script>alert(1)</script>"),
  });
  const refused = await call("POST", `/api/projects/${projectA.id}/footage`, {
    token: tokenA,
    ip: ipA,
    payload: wrongType.payload,
    contentType: wrongType.contentType,
  });
  eq(refused.status, 415, "a text/html upload is 415");
  ok(/video or an image/i.test(refused.json<{ error: string }>().error), "and says what is allowed");
  eq(readdirSync(join(DATA_DIR, "uploads")).length, 1, "and nothing extra was written");

  const notMultipart = await call("POST", `/api/projects/${projectA.id}/footage`, {
    token: tokenA,
    ip: ipA,
    body: { file: "nope" },
  });
  eq(notMultipart.status, 400, "a JSON body on the upload route is 400");
}

section("the upload size cap is the parser's, not an afterthought");
{
  // Its own app, with a 1 KB cap, so the real 200 MB limit does not have
  // to be allocated to prove the path works.
  const tiny = buildApp({ logger: false, worker: false, maxUploadBytes: 1024 });
  await tiny.ready();
  const over = multipart({}, {
    filename: "big.mp4",
    contentType: "video/mp4",
    data: Buffer.alloc(4096, 0x41),
  });
  const response = await tiny.inject({
    method: "POST",
    url: `/api/projects/${projectA.id}/footage`,
    headers: { authorization: `Bearer ${tokenA}`, "content-type": over.contentType },
    payload: over.payload,
    remoteAddress: "10.0.0.77",
  });
  seen.push({ method: "POST", path: "/footage (over cap)", status: response.statusCode, body: response.body });
  eq(response.statusCode, 413, "an over-cap upload is 413");
  eq(readdirSync(join(DATA_DIR, "uploads")).length, 1, "and the truncated file was cleaned up");
  await tiny.close();
}

section("transcribe, and the transcript it produces");
{
  const before = await call("GET", `/api/projects/${projectA.id}/transcript`, { token: tokenA, ip: ipA });
  eq(before.status, 404, "there is no transcript before transcribing");
  ok(/not been transcribed/i.test(before.json<{ error: string }>().error), "and it says so plainly");

  const queued = await call("POST", `/api/projects/${projectA.id}/transcribe`, {
    token: tokenA,
    ip: ipA,
    body: { language: null },
  });
  eq(queued.status, 202, "transcribe answers 202");
  const job = queued.json<Job>();
  eq(job.status, "queued", "with a queued job");
  eq(job.kind, "transcribe", "of the right kind");
  eq(job.simulated, true, "marked simulated, because it is");

  const done = await waitForJob(tokenA, ipA, projectA.id, job.id, "done");
  eq(done?.status, "done", "the worker finishes it");
  eq(done?.progress, 1, "at full progress");
  ok(/simulat/i.test(done?.message ?? ""), "and the message says it was simulated", done?.message ?? "");

  const transcript = await call("GET", `/api/projects/${projectA.id}/transcript`, { token: tokenA, ip: ipA });
  eq(transcript.status, 200, "the transcript is readable");
  const body = transcript.json<{
    projectId: string;
    language: string;
    detectedLanguage: string | null;
    simulated: boolean;
    words: Array<{ text: string; startMs: number; endMs: number; confidence: number }>;
  }>();
  eq(body.projectId, projectA.id, "for the right project");
  eq(body.simulated, true, "flagged simulated in the data too");
  ok(body.words.length > 3, "with word-level timings", `${body.words.length} words`);
  ok(body.detectedLanguage !== null, "and a detected language, since none was given");
  const monotonic = body.words.every(
    (word, index) =>
      word.endMs > word.startMs &&
      (index === 0 || word.startMs >= (body.words[index - 1]?.startMs ?? 0)),
  );
  ok(monotonic, "timings run forwards and do not overlap backwards");
  ok(
    body.words.every((word) => word.confidence > 0 && word.confidence <= 1),
    "confidences are in 0..1",
  );
  ok(
    /simulat/i.test(body.words.map((w) => w.text).join(" ")),
    "and the words themselves say they were simulated, so a screenshot cannot mislead",
  );

  const project = (await call("GET", `/api/projects/${projectA.id}`, { token: tokenA, ip: ipA })).json<Project>();
  eq(project.hasSubtitles, true, "the project now has subtitles");
}

section("render");
{
  const queued = await call("POST", `/api/projects/${projectA.id}/render`, { token: tokenA, ip: ipA });
  eq(queued.status, 202, "render answers 202");
  const job = queued.json<Job>();
  eq(job.kind, "render", "with a render job");

  const mid = (await call("GET", `/api/projects/${projectA.id}`, { token: tokenA, ip: ipA })).json<Project>();
  eq(mid.status, "rendering", "and the project says rendering straight away");

  const done = await waitForJob(tokenA, ipA, projectA.id, job.id, "done");
  eq(done?.status, "done", "the render finishes");

  const project = (await call("GET", `/api/projects/${projectA.id}`, { token: tokenA, ip: ipA })).json<Project>();
  eq(project.status, "ready", "the project is ready");
  ok(project.videoUrl !== null, "and has a video url");
  ok(
    (project.videoUrl ?? "").includes("simulated"),
    "which says in the path that it is simulated, so it cannot be mistaken for a real render",
    project.videoUrl ?? "",
  );
  eq(project.thumbnailUrl, null, "no thumbnail is invented");
}

section("a Starter account cannot dub, and is told which plan can");
{
  const refused = await call("POST", `/api/projects/${projectA.id}/dub`, {
    token: tokenA,
    ip: ipA,
    body: { language: "mr", lipSync: true },
  });
  eq(refused.status, 403, "a dub on Starter is 403");
  const message = refused.json<{ error: string }>().error;
  ok(/starter/i.test(message), "the message names the plan they are on", message);
  ok(/creator/i.test(message), "and names Creator as one that includes dubbing", message);
  ok(/studio/i.test(message), "and Studio", message);
  eq(
    (await call("GET", "/api/account/usage", { token: tokenA, ip: ipA })).json<Usage>().dubSecondsUsed,
    0,
    "and nothing was billed for the attempt",
  );
}

section("a second account cannot touch the first account's project");
const ipB = "10.0.0.2";
let tokenB = "";
{
  const signup = await call("POST", "/api/auth/signup", {
    ip: ipB,
    body: { email: "bhavin@example.com", password: SECRETS[1], name: "Bhavin", region: "WORLD" },
  });
  tokenB = signup.json<{ token: string }>().token;
  await call("POST", "/api/account/plan", { token: tokenB, ip: ipB, body: { planId: "creator" } });

  const asB: Array<["GET" | "POST" | "DELETE", string, unknown]> = [
    ["GET", `/api/projects/${projectA.id}`, undefined],
    ["DELETE", `/api/projects/${projectA.id}`, undefined],
    ["POST", `/api/projects/${projectA.id}/transcribe`, { language: null }],
    ["GET", `/api/projects/${projectA.id}/transcript`, undefined],
    ["POST", `/api/projects/${projectA.id}/dub`, { language: "hi", lipSync: false }],
    ["POST", `/api/projects/${projectA.id}/render`, undefined],
    ["GET", `/api/jobs?projectId=${projectA.id}`, undefined],
  ];
  let allFourOhFour = true;
  const offenders: string[] = [];
  for (const [method, path, body] of asB) {
    const response = await call(method, path, {
      token: tokenB,
      ip: ipB,
      ...(body === undefined ? {} : { body }),
    });
    if (response.status !== 404) {
      allFourOhFour = false;
      offenders.push(`${method} ${path} -> ${response.status}`);
    }
  }
  ok(allFourOhFour, `all ${asB.length} cross-account routes answer 404, not 403`, offenders.join("; "));

  const upload = multipart({}, { filename: "x.mp4", contentType: "video/mp4", data: FAKE_MP4 });
  const footage = await call("POST", `/api/projects/${projectA.id}/footage`, {
    token: tokenB,
    ip: ipB,
    payload: upload.payload,
    contentType: upload.contentType,
  });
  eq(footage.status, 404, "and so does uploading over somebody else's footage");
  eq(readdirSync(join(DATA_DIR, "uploads")).length, 1, "with nothing written for the attempt");

  eq(
    (await call("GET", "/api/projects", { token: tokenB, ip: ipB })).json<Project[]>().length,
    0,
    "the second account's project list is empty",
  );
  eq(
    (await call("GET", "/api/jobs", { token: tokenB, ip: ipB })).json<Job[]>().length,
    0,
    "and so is its job list, though the first account has jobs",
  );
  ok(
    (await call("GET", "/api/jobs", { token: tokenA, ip: ipA })).json<Job[]>().length >= 2,
    "which the first account's own job list proves",
  );

  // The reverse direction, so the check is not accidentally one-way.
  const projectB = (
    await call("POST", "/api/projects", {
      token: tokenB,
      ip: ipB,
      body: { title: "Bhavin's reel", language: "en" },
    })
  ).json<Project>();
  eq(
    (await call("GET", `/api/projects/${projectB.id}`, { token: tokenA, ip: ipA })).status,
    404,
    "and the first account cannot read the second account's project either",
  );
}

section("dub metering on a plan that includes it");
{
  const projectB = (
    await call("POST", "/api/projects", {
      token: tokenB,
      ip: ipB,
      body: { title: "Dubbed four ways", language: "en" },
    })
  ).json<Project>();

  const upload = multipart({ seconds: "60" }, {
    filename: "clip.mp4",
    contentType: "video/mp4",
    data: FAKE_MP4,
  });
  await call("POST", `/api/projects/${projectB.id}/footage`, {
    token: tokenB,
    ip: ipB,
    payload: upload.payload,
    contentType: upload.contentType,
  });

  const tooEarly = await call("POST", `/api/projects/${projectB.id}/dub`, {
    token: tokenB,
    ip: ipB,
    body: { language: "hi", lipSync: true },
  });
  eq(tooEarly.status, 409, "dubbing before transcribing is 409");
  ok(/transcribe/i.test(tooEarly.json<{ error: string }>().error), "and says to transcribe first");

  const transcribe = (
    await call("POST", `/api/projects/${projectB.id}/transcribe`, {
      token: tokenB,
      ip: ipB,
      body: { language: "en" },
    })
  ).json<Job>();
  // The contract says `language` is "Only set on `dub`". A transcribe job
  // stores the hint it was given, and must not report it.
  ok(
    !("language" in transcribe),
    "a transcribe job carries no language on the wire, as the contract says",
    JSON.stringify(transcribe),
  );
  await waitForJob(tokenB, ipB, projectB.id, transcribe.id, "done");

  const first = await call("POST", `/api/projects/${projectB.id}/dub`, {
    token: tokenB,
    ip: ipB,
    body: { language: "hi", lipSync: true },
  });
  eq(first.status, 202, "the first dub is accepted");
  eq(first.json<Job>().language, "hi", "and carries the language, which only a dub does");

  let usage = (await call("GET", "/api/account/usage", { token: tokenB, ip: ipB })).json<Usage>();
  eq(usage.dubSecondsIncluded, 180, "Creator includes 3 minutes");
  eq(usage.dubSecondsUsed, 60, "one 60-second dub is counted");
  eq(usage.overageDue, 0, "nothing owed inside the allowance");

  for (const language of ["mr", "ta"]) {
    const response = await call("POST", `/api/projects/${projectB.id}/dub`, {
      token: tokenB,
      ip: ipB,
      body: { language, lipSync: false },
    });
    eq(response.status, 202, `dubbing into ${language} is accepted`);
  }
  usage = (await call("GET", "/api/account/usage", { token: tokenB, ip: ipB })).json<Usage>();
  eq(usage.dubSecondsUsed, 180, "three dubs use the whole allowance");
  eq(usage.overageDue, 0, "exactly at the allowance, nothing is owed");

  await call("POST", `/api/projects/${projectB.id}/dub`, {
    token: tokenB,
    ip: ipB,
    body: { language: "te", lipSync: false },
  });
  usage = (await call("GET", "/api/account/usage", { token: tokenB, ip: ipB })).json<Usage>();
  eq(usage.dubSecondsUsed, 240, "a fourth dub goes past it");
  eq(
    usage.overageDue,
    DUB_OVERAGE_PER_MINUTE.WORLD,
    "and one minute of overage is owed at the WORLD rate",
  );

  const finished = await waitForJob(tokenB, ipB, projectB.id, first.json<Job>().id, "done");
  eq(finished?.status, "done", "the dub job itself completes");
  const project = (await call("GET", `/api/projects/${projectB.id}`, { token: tokenB, ip: ipB })).json<Project>();
  ok(project.dubbedInto.includes("hi"), "and the language lands on the project", project.dubbedInto.join(","));

  const noLipSync = await call("POST", `/api/projects/${projectB.id}/dub`, {
    token: tokenB,
    ip: ipB,
    body: { language: "ml" },
  });
  eq(noLipSync.status, 400, "a dub with no lipSync flag is 400");
  eq(noLipSync.json<{ field?: string }>().field, "lipSync", "and names the field");
}

section("the reel cap is enforced, not silently exceeded");
const ipC = "10.0.0.3";
{
  const signup = await call("POST", "/api/auth/signup", {
    ip: ipC,
    body: { email: "chetan@example.com", password: SECRETS[2], name: "Chetan", region: "IN" },
  });
  const tokenC = signup.json<{ token: string }>().token;
  await call("POST", "/api/account/plan", { token: tokenC, ip: ipC, body: { planId: "starter" } });

  const cap = PLANS.starter.reels;
  let accepted = 0;
  for (let n = 0; n < cap; n += 1) {
    const response = await call("POST", "/api/projects", {
      token: tokenC,
      ip: ipC,
      body: { title: `Reel ${n + 1}`, language: "mr" },
    });
    if (response.status === 201) accepted += 1;
  }
  eq(accepted, cap, `all ${cap} of Starter's reels are allowed`);

  const overCap = await call("POST", "/api/projects", {
    token: tokenC,
    ip: ipC,
    body: { title: "One too many", language: "mr" },
  });
  eq(overCap.status, 403, "the next one is refused");
  const message = overCap.json<{ error: string }>().error;
  ok(message.includes(String(cap)), "the message says what the allowance is", message);
  ok(/starter/i.test(message), "and which plan it belongs to", message);
  ok(/resets on \d{4}-\d{2}-\d{2}/.test(message), "and when it resets", message);

  const usage = (await call("GET", "/api/account/usage", { token: tokenC, ip: ipC })).json<Usage>();
  eq(usage.reelsUsed, cap, "usage is at the cap exactly -- the refused attempt was not counted");

  // Concurrency, which is the case a check-then-write would get wrong.
  const burst = await Promise.all(
    Array.from({ length: 8 }, (_, n) =>
      call("POST", "/api/projects", {
        token: tokenC,
        ip: ipC,
        body: { title: `Burst ${n}`, language: "mr" },
      }),
    ),
  );
  ok(
    burst.every((response) => response.status === 403),
    "eight simultaneous attempts past the cap are all refused",
    burst.map((r) => r.status).join(","),
  );
  eq(
    (await call("GET", "/api/account/usage", { token: tokenC, ip: ipC })).json<Usage>().reelsUsed,
    cap,
    "and the count did not move",
  );
}

section("the catalogue the pages show is the one the API enforces");
{
  // There used to be two copies of these numbers, compared here by reading
  // the web app's file off disk. Both now derive from one module, so this
  // checks the property that mattered -- the price a visitor reads and the
  // limit their account gets are the same value -- through the real route.
  const res = await call("GET", "/api/catalogue", { ip: "10.0.0.240" });
  eq(res.status, 200, "the catalogue is public: a visitor with no account can read it");
  const raw = await app.inject({ method: "GET", url: "/api/catalogue", remoteAddress: "10.0.0.241" });
  ok(String(raw.headers["cache-control"] ?? "").includes("max-age=300"), "and is cacheable for five minutes");
  const served = res.json<{
    plans: { id: "starter" | "creator" | "studio"; reels: number; dubMinutes: number; channels: number }[];
    metered: { dubMinute: { IN: number; WORLD: number } };
    languages: { code: string }[];
  }>();
  for (const plan of served.plans) {
    eq(plan.reels, PLANS[plan.id].reels, `${plan.id}: the page's reel count is the enforced cap (${plan.reels})`);
    eq(plan.dubMinutes, PLANS[plan.id].dubMinutes, `${plan.id}: dub minutes agree (${plan.dubMinutes})`);
    eq(plan.channels, PLANS[plan.id].channels, `${plan.id}: channels agree (${plan.channels})`);
  }
  eq(served.plans.length, Object.keys(PLANS).length, "every enforced plan is on the page, and no others");
  eq(served.metered.dubMinute.IN, DUB_OVERAGE_PER_MINUTE.IN, "the IN overage rate shown is the one billed");
  eq(served.metered.dubMinute.WORLD, DUB_OVERAGE_PER_MINUTE.WORLD, "the WORLD overage rate shown is the one billed");
  ok(served.languages.some((l) => l.code === "hi"), "and the language list is served with it");
  // Starter being zero is what the dub refusal depends on being true.
  eq(PLANS.starter.dubMinutes, 0, "Starter includes no dubbing, which is what the refusal rests on");
}

section("the auth routes are limited harder than the rest");
{
  ok(
    AUTH_RATE_LIMIT_PER_MINUTE < 300,
    `the auth limit (${AUTH_RATE_LIMIT_PER_MINUTE}/min) is below the global one (300/min)`,
  );

  const strict = buildApp({ logger: false, worker: false, authRateLimitMax: 2 });
  await strict.ready();
  const attempt = async () =>
    strict.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "asha@example.com", password: "wrong-every-time" },
      remoteAddress: "10.0.0.250",
    });
  const statuses = [
    (await attempt()).statusCode,
    (await attempt()).statusCode,
    (await attempt()).statusCode,
  ];
  eq(statuses[0], 401, "the first attempt is refused on its merits");
  eq(statuses[1], 401, "so is the second");
  eq(statuses[2], 429, "the third is throttled");

  // A route outside the auth scope must not inherit the strict limit.
  const health = await strict.inject({ method: "GET", url: "/health", remoteAddress: "10.0.0.250" });
  eq(health.statusCode, 200, "and the health check is not throttled with it");
  await strict.close();
}

section("no response in this whole run leaked a password or a hash");
{
  // Prose is allowed to use the word -- "Invalid email or password." is a
  // response this suite asserts on. What must never appear is the field
  // name, a password this suite used, or anything shaped like a bcrypt
  // hash.
  const offenders: string[] = [];
  for (const entry of seen) {
    const found: string[] = [];
    if (/passwordhash/i.test(entry.body)) found.push("passwordHash");
    if (/"password"\s*:/i.test(entry.body)) found.push('"password":');
    if (/\$2[aby]\$\d\d\$/.test(entry.body)) found.push("a bcrypt hash");
    for (const secret of SECRETS) if (secret && entry.body.includes(secret)) found.push("a password");
    if (found.length > 0) {
      offenders.push(`${entry.method} ${entry.path} (${entry.status}): ${found.join(", ")}`);
    }
  }
  ok(
    offenders.length === 0,
    `${seen.length} responses scanned, none carried passwordHash, a password field or a hash`,
    offenders.join("\n          "),
  );

  // And the hash is genuinely in the store, at the cost we claim, so the
  // check above is proving absence from responses rather than absence
  // altogether.
  const onDisk = JSON.parse(readFileSync(store.storeFile(), "utf8")) as {
    accounts: Array<{ email: string; passwordHash: string }>;
  };
  const asha = onDisk.accounts.find((a) => a.email === "asha@example.com");
  ok(asha !== undefined, "the account is on disk");
  ok(/^\$2[aby]\$12\$/.test(asha?.passwordHash ?? ""), "with a bcrypt hash at cost 12", asha?.passwordHash?.slice(0, 7));
  ok(
    !onDisk.accounts.some((a) => SECRETS.includes(a.passwordHash)),
    "and no plaintext password is stored anywhere",
  );
}

section("the store writes atomically and survives being re-read");
{
  await store.flushWrites();

  const text = readFileSync(store.storeFile(), "utf8");
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  ok(parsed !== null, "the file on disk is complete, valid JSON");

  const leftovers = readdirSync(DATA_DIR).filter((name) => name.endsWith(".tmp"));
  eq(leftovers.length, 0, "no temp files are left behind by the write-then-rename");

  // Drop the in-memory copy and read it back from disk. This is the check
  // that distinguishes "the store works" from "the store never wrote
  // anything and the heap happened to have the right answer".
  const expectedProjects = (await store.listProjects(accountA.id)).length;
  await store.forgetCachedStore();

  const reloaded = await store.findAccountByEmail("asha@example.com");
  ok(reloaded !== null, "the account is still there after a cold read");
  eq(reloaded?.id, accountA.id, "with the same id");
  eq(reloaded?.name, "Asha", "the same name");
  eq(reloaded?.planId, "starter", "and the plan that was chosen");
  eq((await store.listProjects(accountA.id)).length, expectedProjects, "and the same projects");

  const project = await store.findProject(accountA.id, projectA.id);
  eq(project?.status, "ready", "a project's rendered state survived the round trip");
  eq(project?.seconds, 30, "and its duration");
  eq(project?.secondsSource, "client", "recorded as client-reported, because that is what it was");

  const transcript = await store.findTranscript(accountA.id, projectA.id);
  ok(transcript !== null, "so did the transcript");
  eq(transcript?.simulated, true, "still marked simulated on disk");
}

section("concurrent writes all land");
{
  const signup = await call("POST", "/api/auth/signup", {
    ip: "10.0.0.4",
    body: { email: "dia@example.com", password: SECRETS[1], name: "Dia", region: "IN" },
  });
  const token = signup.json<{ token: string }>().token;
  await call("POST", "/api/account/plan", { token, ip: "10.0.0.4", body: { planId: "studio" } });

  // Twelve at once. With the whole file as the unit of writing, an
  // unserialised store loses all but one of these: each request would
  // read the same copy, add its own project and write the lot back.
  const responses = await Promise.all(
    Array.from({ length: 12 }, (_, n) =>
      call("POST", "/api/projects", {
        token,
        ip: "10.0.0.4",
        body: { title: `Parallel ${n}`, language: "en" },
      }),
    ),
  );
  ok(
    responses.every((response) => response.status === 201),
    "all twelve simultaneous creations are accepted",
  );
  const ids = new Set(responses.map((response) => response.json<Project>().id));
  eq(ids.size, 12, "with twelve distinct ids");

  await store.flushWrites();
  await store.forgetCachedStore();
  const account = await store.findAccountByEmail("dia@example.com");
  const projects = account ? await store.listProjects(account.id) : [];
  eq(projects.length, 12, "and all twelve are on disk after a cold read");
  eq(
    (await call("GET", "/api/account/usage", { token, ip: "10.0.0.4" })).json<Usage>().reelsUsed,
    12,
    "with twelve reels counted, not one",
  );
}

// ---------------------------------------------------------------------------

await app.close();
try {
  rmSync(DATA_DIR, { recursive: true, force: true });
} catch {
  // Windows holds a handle open a moment after close; a leftover temp
  // directory is not worth failing a passing suite over.
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
