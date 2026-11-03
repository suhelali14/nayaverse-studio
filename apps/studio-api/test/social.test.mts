/**
 * Connections, Insights and Ideas through the real routes, with fake
 * platforms standing in for Instagram, YouTube and TikTok.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA_DIR = mkdtempSync(join(tmpdir(), "studio-social-test-"));
process.env.NODE_ENV = "test";
process.env.STUDIO_DATA_DIR = DATA_DIR;
process.env.STUDIO_UPLOAD_DIR = join(DATA_DIR, "uploads");
delete process.env.JWT_SECRET;
delete process.env.ANTHROPIC_API_KEY;

const { buildApp } = await import("../src/app.js");
const { seal, unseal, isoDuration, PlatformError } = await import("../src/lib/social.js");
const { AiUnavailable } = await import("../src/lib/ai.js");
const { flushWrites, storeFile } = await import("../src/lib/store.js");
type PlatformAdapter = import("../src/lib/social.js").PlatformAdapter;
type IdeaModel = import("../src/lib/ideas.js").IdeaModel;
type SocialPost = import("../../studio/src/lib/insights.js").SocialPost;
type Platform = import("../../studio/src/lib/insights.js").Platform;

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
const eq = <T,>(a: T, b: T, what: string) => ok(a === b, what, `expected ${String(b)}, got ${String(a)}`);

console.log("\ntokens at rest");
{
  const sealed = seal("secret-token-123");
  ok(!sealed.includes("secret-token-123"), "a sealed token does not contain the token");
  eq(unseal(sealed), "secret-token-123", "and unseals to it");
  ok(seal("x") !== seal("x"), "sealing twice gives different ciphertexts");
  const tampered = Buffer.from(sealed, "base64");
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
  let threw = false;
  try {
    unseal(tampered.toString("base64"));
  } catch {
    threw = true;
  }
  ok(threw, "a tampered token fails to unseal rather than decrypting to garbage");
  eq(isoDuration("PT1M5S"), 65, "YouTube's PT1M5S is 65 seconds");
  eq(isoDuration("PT45S"), 45, "and PT45S is 45");
}

// ── Fake platforms ──────────────────────────────────────────────────────

const now = Date.now();
const fakePosts = (platform: Platform): SocialPost[] =>
  Array.from({ length: 9 }, (_, i) => ({
    platform,
    id: platform + i,
    publishedAt: new Date(now - (i + 1) * 3 * 86_400_000).toISOString(),
    caption: i % 3 === 0 ? "Why is every chai stall full at 6? #chai" : "Morning commute in the city",
    url: null,
    thumbnail: null,
    format: "reel",
    durationSec: 20,
    views: i % 3 === 0 ? 5000 : 1000,
    reach: null,
    likes: 40,
    comments: 4,
    shares: 2,
    saves: 1,
  }));

let failSync = false;
const fake = (id: Platform, configured = true): PlatformAdapter => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  configured,
  authorizeUrl: (state, redirect) => `https://auth.example/${id}?state=${state}&redirect_uri=${encodeURIComponent(redirect)}`,
  exchange: async (code) => {
    if (code === "bad") throw new PlatformError(`${id} sign-in failed: invalid code.`);
    return { accessToken: `plain-access-${id}-${code}`, refreshToken: `plain-refresh-${id}`, expiresAt: new Date(now + 30 * 86_400_000).toISOString(), externalId: "ext-" + id };
  },
  refresh: async (t) => t,
  profile: async () => ({ handle: "@riya." + id, displayName: "Riya", avatar: null, followers: 1200 }),
  posts: async () => {
    if (failSync) throw new PlatformError("Reading posts failed: token revoked.");
    return fakePosts(id);
  },
});

const ideaCalls: unknown[] = [];
let modelFails = false;
const model: IdeaModel = {
  name: "fake-model",
  ideas: async (input) => {
    ideaCalls.push(input);
    if (modelFails) throw new AiUnavailable(503, "AI writing is not available on this server right now.", "fake");
    return [{ title: "Chai at six", hook: "Why is every stall full at 6?", angle: "Follow one stall", why: "Your #chai posts get 5×.", script: "Why is every stall full at 6? ..." }];
  },
};

const app = buildApp({
  worker: false,
  paymentGateway: null,
  authRateLimitMax: 1000,
  socialAdapters: { instagram: fake("instagram"), youtube: fake("youtube"), tiktok: fake("tiktok", false) },
  ideaModel: model,
});

async function call(method: "GET" | "POST" | "DELETE", url: string, token?: string, body?: unknown) {
  const res = await app.inject({
    method,
    url,
    remoteAddress: "10.6.0.1",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: res.statusCode, headers: res.headers, json: <T,>() => JSON.parse(res.body) as T };
}

let seq = 0;
async function signUp(region: "IN" | "WORLD" = "IN"): Promise<string> {
  seq += 1;
  const t = (await call("POST", "/api/auth/signup", undefined, { email: `creator${seq}@example.com`, password: "a long enough passphrase", name: "Riya " + seq, region })).json<{ token: string }>().token;
  await call("POST", "/api/account/plan", t, { planId: "creator" });
  return t;
}

/** Start a sign-in and come back from it with `code`, as the browser would. */
async function connect(token: string, platform: Platform, code = "good") {
  const start = await call("POST", `/api/connections/${platform}/start`, token);
  const url = new URL(start.json<{ url: string }>().url);
  const state = url.searchParams.get("state")!;
  const back = await call("GET", `/api/connections/${platform}/callback?code=${code}&state=${encodeURIComponent(state)}`);
  return { start, back, state };
}

type Listed = { platforms: { id: string; configured: boolean; connection: { handle: string; posts: number; lastError: string | null } | null }[] };

console.log("\nconnections");
const riya = await signUp("IN");
{
  const list = (await call("GET", "/api/connections", riya)).json<Listed>();
  ok(JSON.stringify(list.platforms.map((p) => p.id)) === '["instagram","youtube"]', "India sees Instagram and YouTube, not TikTok", JSON.stringify(list.platforms.map((p) => p.id)));
  const abroad = await signUp("WORLD");
  const world = (await call("GET", "/api/connections", abroad)).json<Listed>();
  eq(world.platforms.length, 3, "outside India, TikTok is listed too");
  eq(world.platforms.find((p) => p.id === "tiktok")?.configured, false, "and says when it is not set up on this server");
  eq((await call("POST", "/api/connections/tiktok/start", abroad)).status, 409, "starting an unconfigured platform is refused with a reason");
  eq((await call("POST", "/api/connections/tiktok/start", riya)).status, 403, "and TikTok cannot be started from India at all");

  const { start, back, state } = await connect(riya, "instagram");
  eq(start.status, 200, "starting returns the platform's sign-in address");
  ok(decodeURIComponent(start.json<{ url: string }>().url).includes("/api/connections/instagram/callback"), "with this API's callback as the redirect");
  eq(back.status, 302, "the callback sends the browser back to the app");
  ok(String(back.headers.location).endsWith("/app/connections?connected=instagram"), "to the connections page, saying what connected", String(back.headers.location));

  const replay = await call("GET", `/api/connections/instagram/callback?code=again&state=${encodeURIComponent(state)}`);
  ok(String(replay.headers.location).includes("error="), "a state cannot be used twice");
  const forged = await call("GET", `/api/connections/instagram/callback?code=x&state=made-up`);
  ok(String(forged.headers.location).includes("error="), "nor can one that was never issued");

  const after = (await call("GET", "/api/connections", riya)).json<Listed>();
  const ig = after.platforms.find((p) => p.id === "instagram")!.connection;
  eq(ig?.handle, "@riya.instagram", "the connection shows the account's handle");
  eq(ig?.posts, 9, "and its posts were synced on connect");

  await flushWrites();
  const disk = readFileSync(storeFile(), "utf8");
  ok(!disk.includes("plain-access-instagram") && !disk.includes("plain-refresh-instagram"), "no token is written to disk in the clear");

  const other = await signUp("IN");
  const otherList = (await call("GET", "/api/connections", other)).json<Listed>();
  ok(otherList.platforms.every((p) => p.connection === null), "another account sees none of Riya's connections");

  const bad = await connect(riya, "youtube", "bad");
  ok(decodeURIComponent(String(bad.back.headers.location)).includes("invalid code"), "a failed sign-in comes back with the platform's reason");
}

console.log("\nsync");
{
  failSync = true;
  const r = await call("POST", "/api/connections/instagram/sync", riya);
  eq(r.status, 502, "a failed sync is reported");
  const listed = (await call("GET", "/api/connections", riya)).json<Listed>();
  ok((listed.platforms.find((p) => p.id === "instagram")!.connection?.lastError ?? "").includes("revoked"), "and recorded on the connection for the page to show");
  failSync = false;
  const again = await call("POST", "/api/connections/instagram/sync", riya);
  eq(again.status, 200, "a retry that works clears it");
  eq(again.json<{ lastError: string | null }>().lastError, null, "with no error left behind");
}

console.log("\ninsights and ideas");
{
  const r = (await call("GET", "/api/insights", riya)).json<{ report: { posts: number; topics: { label: string }[] }; connected: number }>();
  eq(r.report.posts, 9, "the report covers the synced posts");
  ok(r.report.topics.some((t) => t.label === "#chai"), "and finds the topic the posts were built around");
  eq(r.connected, 1, "and says how many accounts it came from");
  eq((await call("GET", "/api/insights?platform=youtube", riya)).json<{ report: { posts: number } }>().report.posts, 0, "a platform with nothing synced has an empty report");

  const ideas = await call("POST", "/api/ideas", riya, { niche: "Mumbai city life", language: "hi" });
  eq(ideas.status, 200, "ideas are made");
  eq(ideas.json<{ source: string }>().source, "model", "by the model when there is one");
  const sent = ideaCalls[ideaCalls.length - 1] as { niche: string; language: string; report: { posts: number } };
  eq(sent.report.posts, 9, "which is given the creator's own report");
  eq(sent.language, "hi", "and the language asked for");

  modelFails = true;
  const fallback = (await call("POST", "/api/ideas", riya, { niche: "Mumbai city life" })).json<{ source: string; ideas: { why: string }[]; note: string }>();
  eq(fallback.source, "rules", "when the model fails, the ideas come from the rules");
  ok(fallback.ideas.length > 0 && fallback.ideas[0]!.why.includes("#chai"), "still grounded in the creator's numbers", fallback.ideas[0]?.why);
  ok(fallback.note.length > 0, "and the page is told why");
  modelFails = false;

  const unplanned = (await call("POST", "/api/auth/signup", undefined, { email: "noplan@example.com", password: "a long enough passphrase", name: "No Plan", region: "IN" })).json<{ token: string }>().token;
  eq((await call("POST", "/api/ideas", unplanned, {})).status, 403, "ideas need a plan, like everything else that costs money");
}

console.log("\ndisconnecting");
{
  eq((await call("DELETE", "/api/connections/instagram", riya)).status, 200, "an account can be disconnected");
  eq((await call("GET", "/api/insights", riya)).json<{ report: { posts: number } }>().report.posts, 0, "and its posts go with it");
}

await app.close();
await flushWrites();
rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
