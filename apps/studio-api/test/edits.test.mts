/**
 * Saving a reel's edit: shape, size, ownership and the revision check that
 * stops two tabs overwriting each other.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA_DIR = mkdtempSync(join(tmpdir(), "studio-edits-test-"));
process.env.NODE_ENV = "test";
process.env.STUDIO_DATA_DIR = DATA_DIR;
process.env.STUDIO_UPLOAD_DIR = join(DATA_DIR, "uploads");
delete process.env.JWT_SECRET;

const { buildApp } = await import("../src/app.js");
const { flushWrites } = await import("../src/lib/store.js");

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

const app = buildApp({ worker: false, paymentGateway: null, authRateLimitMax: 1000 });
async function call(method: "GET" | "PUT" | "POST" | "DELETE", url: string, token?: string, body?: unknown) {
  const res = await app.inject({ method, url, remoteAddress: "10.9.0.3", headers: token ? { authorization: `Bearer ${token}` } : {}, ...(body === undefined ? {} : { payload: body as object }) });
  return { status: res.statusCode, headers: res.headers, json: <T,>() => JSON.parse(res.body) as T };
}
async function account(email: string): Promise<string> {
  const t = (await call("POST", "/api/auth/signup", undefined, { email, password: "a long enough passphrase", name: "Riya Desai", region: "IN" })).json<{ token: string }>().token;
  await call("POST", "/api/account/plan", t, { planId: "creator" });
  return t;
}

const doc = (caption = "Mumbai wakes up before the sun does.") => ({
  version: 1,
  timeline: {
    fps: 30,
    tracks: [
      {
        id: "v1",
        kind: "video",
        clips: [
          { id: "d1-ab12", start: 0, duration: 2.9, sourceIn: 0, caption, source: { kind: "photo", path: "morning-sun.jpg" }, grade: { exposure: 1.04, contrast: 1.06, saturation: 1.1, warmth: 0.5 }, zoom: { from: 1, to: 1.12 } },
          { id: "d2-cd34", start: 2.9, duration: 3.1, sourceIn: 1.5, caption: "The first trains are full by five.", source: { kind: "clip", path: "train.mp4", from: 1.5, to: 4.6 }, speed: 1.5, fadeOut: 0.5 },
        ],
      },
      { id: "a1", kind: "audio", clips: [{ id: "m1", start: 0, duration: 6, sourceIn: 0, caption: "", source: { kind: "clip", path: "beat.mp3", from: 0, to: 6 }, volume: 0.25 }] },
    ],
  },
  markers: [1.5, 4],
  captionStyle: { size: "M", position: "low", colour: "yellow" },
  media: [
    { name: "morning-sun.jpg", kind: "photo", seconds: null },
    { name: "train.mp4", kind: "clip", seconds: 12.4 },
    { name: "beat.mp3", kind: "audio", seconds: 16 },
  ],
  shots: [["d1-ab12", { role: "hook", label: "Hook", match: null, visual: "sun" }]],
  scripted: [["d1-ab12", [{ startMs: 0, endMs: 1200, lines: ["Mumbai wakes up"], words: [{ text: "Mumbai", startMs: 0, endMs: 400 }] }]]],
});

const t = await account("edits@example.com");
const project = (await call("POST", "/api/projects", t, { title: "Saved reel", language: "en" })).json<{ id: string }>();
const url = `/api/projects/${project.id}/edit`;

console.log("\nsaving and opening");
{
  const empty = await call("GET", url, t);
  ok(empty.status === 200 && empty.json<{ doc: unknown; revision: number }>().doc === null, "a new reel has nothing saved yet, at revision 0");
  eq(empty.headers["cache-control"], "no-store", "and it is never cached");
  const saved = await call("PUT", url, t, { baseRevision: 0, doc: doc() });
  eq(saved.status, 200, "the first save is taken");
  eq(saved.json<{ revision: number }>().revision, 1, "as revision 1");
  const back = (await call("GET", url, t)).json<{ revision: number; doc: ReturnType<typeof doc> }>();
  ok(JSON.stringify(back.doc) === JSON.stringify(doc()), "and comes back exactly as it went in");
  eq((await call("PUT", url, t, { baseRevision: 1, doc: doc("Edited.") })).json<{ revision: number }>().revision, 2, "the next save builds on it");
}

console.log("\ntwo tabs");
{
  const stale = await call("PUT", url, t, { baseRevision: 1, doc: doc("From an old tab.") });
  eq(stale.status, 409, "a save from a tab that missed the last one is refused");
  eq(stale.json<{ revision: number }>().revision, 2, "and told which revision is current");
  ok((await call("GET", url, t)).json<{ doc: { timeline: { tracks: { clips: { caption: string }[] }[] } } }>().doc.timeline.tracks[0]!.clips[0]!.caption === "Edited.", "the newer work survives");
}

console.log("\nwhat is refused");
{
  const bad = (patch: (d: ReturnType<typeof doc>) => unknown) => call("PUT", url, t, { baseRevision: 2, doc: patch(doc()) });
  eq((await bad((d) => ({ ...d, version: 2 }))).status, 400, "an unknown document version");
  eq((await bad((d) => { d.timeline.tracks[0]!.clips[0]!.duration = -1; return d; })).status, 400, "a clip with a negative length");
  eq((await bad((d) => { (d.timeline.tracks[0]!.clips[0]!.source as { kind: string }).kind = "virus"; return d; })).status, 400, "a source kind the editor does not have");
  eq((await bad((d) => { (d.timeline.tracks[0]!.clips[0]! as { start: unknown }).start = "soon"; return d; })).status, 400, "a time that is not a number");
  // Loosely typed on purpose: it is grown past what the schema allows.
  const huge = doc() as unknown as { timeline: { tracks: { id: string; clips: Record<string, unknown>[] }[] } };
  huge.timeline.tracks[0]!.clips[0]!.caption = "x".repeat(1999);
  for (let i = 0; i < 499; i += 1) huge.timeline.tracks[0]!.clips.push({ ...huge.timeline.tracks[0]!.clips[0]!, id: "c" + i });
  for (let i = 0; i < 2; i += 1) huge.timeline.tracks.push({ ...huge.timeline.tracks[0]!, id: "x" + i });
  const big = await call("PUT", url, t, { baseRevision: 2, doc: huge });
  ok(big.status === 413 || big.status === 400, "an edit too large to be a reel", String(big.status));
  eq((await call("GET", url, t)).json<{ revision: number }>().revision, 2, "and nothing refused was stored");
}

console.log("\nwhose it is");
{
  const other = await account("other-edits@example.com");
  eq((await call("GET", url, other)).status, 404, "someone else cannot read it");
  eq((await call("PUT", url, other, { baseRevision: 2, doc: doc("Mine now") })).status, 404, "or write it");
  eq((await call("GET", url)).status, 401, "nor can nobody");
  eq((await call("DELETE", `/api/projects/${project.id}`, t)).status, 204, "deleting the reel");
  eq((await call("GET", url, t)).status, 404, "takes its edit with it");
}

await app.close();
await flushWrites();
rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
