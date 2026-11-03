/**
 * The store's write path, against a file another process is holding open.
 *
 * ── Why this suite exists ───────────────────────────────────────────────
 *
 * `persist` writes a temp file and renames it over the store. The rename is
 * atomic, and the module's comment said so, and that was treated as the end
 * of the question. It is not: atomic says the file is never half-written, it
 * says nothing about whether the rename is *allowed*. On Windows it often is
 * not. OneDrive, Defender and the search indexer all open a file moments
 * after it changes, and `MoveFileEx` onto a handle another process holds
 * fails with `EPERM`.
 *
 * That is not a theoretical platform note. It is what actually happened on
 * the machine this was developed on: the API answered 200 to every request,
 * the worker logged `tick failed` into a log nobody reads, and the store on
 * disk never changed. An account created, a plan chosen, a job finished --
 * all of it gone on the next restart. `api.test.mts` even works around the
 * same handles in its own cleanup, with a comment calling them "not worth
 * failing a passing suite over", which was true of the cleanup and quietly
 * wrong about the store.
 *
 * So the write path is tested the only way that means anything: by taking
 * the lock for real, from another process, and seeing what survives.
 *
 * ── How the lock is taken ───────────────────────────────────────────────
 *
 * PowerShell opens the store with `FileShare.None`, which blocks a rename
 * onto it, prints `LOCKED`, waits, and closes. No npm dependency can do
 * this -- Node's own `fs.open` gives no control over the Windows share
 * mode, so a Node-held handle does not reproduce the failure at all.
 *
 * On anything but Windows there is no such sharing model and nothing to
 * reproduce, so the suite says so and passes rather than pretending.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA_DIR = mkdtempSync(join(tmpdir(), "studio-store-test-"));

process.env.NODE_ENV = "test";
process.env.STUDIO_DATA_DIR = DATA_DIR;
process.env.STUDIO_UPLOAD_DIR = join(DATA_DIR, "uploads");
delete process.env.JWT_SECRET;

const store = await import("../src/lib/store.js");

const FILE = join(DATA_DIR, "studio.json");

// ---------------------------------------------------------------------------
// Harness, matching api.test.mts.

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

/** Temp files still sitting beside the store. Each one is a full copy of it. */
const strayTempFiles = (): string[] =>
  readdirSync(DATA_DIR).filter((name) => name.endsWith(".tmp"));

const accountsOnDisk = (): string[] => {
  const raw = JSON.parse(readFileSync(FILE, "utf8")) as {
    accounts: { email: string }[];
  };
  return raw.accounts.map((a) => a.email);
};

const newAccount = (email: string) => ({
  email,
  name: email,
  // A real hash is not the point here; the write path is. `insertAccount`
  // stores whatever it is handed, so this suite skips bcrypt's 300ms.
  passwordHash: "$2b$12$not.a.real.hash.this.suite.never.verifies.it",
  region: "IN" as const,
});

/**
 * Hold `FILE` open with no sharing for `ms`, and resolve once it is held.
 *
 * Resolving on the `LOCKED` line rather than after a sleep is what makes
 * this deterministic: the save under test begins when the lock is known to
 * be held, not when it is merely likely to be.
 */
function holdLock(ms: number): Promise<{ released: Promise<void> }> {
  const script = [
    `$f=[System.IO.File]::Open('${FILE.replace(/'/g, "''")}','Open','ReadWrite','None')`,
    `Write-Output 'LOCKED'`,
    `Start-Sleep -Milliseconds ${ms}`,
    `$f.Close()`,
  ].join("; ");

  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const released = new Promise<void>((resolve) => child.on("close", () => resolve()));

  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.includes("LOCKED")) resolve({ released });
    });
    child.on("close", () => {
      if (!out.includes("LOCKED")) reject(new Error("powershell never took the lock"));
    });
  });
}

const isWindows = process.platform === "win32";

// ---------------------------------------------------------------------------
console.log("\n## an ordinary save");

{
  const created = await store.insertAccount(newAccount("first@example.com"));
  ok(created !== "duplicate", "an account is inserted");
  await store.flushWrites();
  eq(accountsOnDisk().length, 1, "and it is on disk");
  eq(strayTempFiles().length, 0, "leaving no temp file behind");
}

// ---------------------------------------------------------------------------
console.log("\n## a save while another process holds the file open");

if (!isWindows) {
  console.log("  skip  not Windows: no share mode to reproduce, nothing to prove");
} else {
  // Shorter than the retry budget (~1.1s), long enough that the first
  // several attempts are guaranteed to fail.
  const { released } = await holdLock(400);

  const started = Date.now();
  let threw: unknown = null;
  try {
    const created = await store.insertAccount(newAccount("locked@example.com"));
    ok(created !== "duplicate", "the save goes through");
  } catch (error) {
    threw = error;
    ok(false, "the save goes through", `threw ${String(error)}`);
  }
  const waited = Date.now() - started;
  await released;

  ok(threw === null, "no EPERM reaches the caller");
  ok(waited >= 100, "and it did have to wait for the lock", `waited ${waited}ms`);

  await store.flushWrites();
  ok(
    accountsOnDisk().includes("locked@example.com"),
    "the account written under the lock is on disk",
  );
  eq(strayTempFiles().length, 0, "and no temp copy of the store was leaked");

  // The property that actually matters: a cold read sees it. This is what
  // was failing in development -- everything looked right until a restart.
  await store.forgetCachedStore();
  const reread = await store.findAccountByEmail("locked@example.com");
  ok(reread !== null, "and a cold read still finds it after a restart");
}

// ---------------------------------------------------------------------------
console.log("\n## a lock held longer than the retry budget");

if (!isWindows) {
  console.log("  skip  not Windows");
} else {
  const { released } = await holdLock(3000);

  let threw: unknown = null;
  try {
    await store.insertAccount(newAccount("doomed@example.com"));
  } catch (error) {
    threw = error;
  }

  // Failing loudly is correct. A save that cannot happen must not report
  // success -- the caller has to be able to tell the user.
  ok(threw !== null, "the save fails rather than silently losing the write");
  eq(
    String((threw as { code?: string } | null)?.code),
    "EPERM",
    "with the real OS error, not a wrapped one",
  );
  eq(strayTempFiles().length, 0, "and the temp copy is cleaned up even on failure");

  await released;

  // And the store is still usable afterwards: a failed write must not wedge
  // the lock or leave the in-memory copy disagreeing with the disk.
  const after = await store.insertAccount(newAccount("after@example.com"));
  ok(after !== "duplicate", "the next save succeeds once the lock is gone");
  await store.flushWrites();
  ok(accountsOnDisk().includes("after@example.com"), "and lands on disk");
  ok(
    !accountsOnDisk().includes("doomed@example.com"),
    "while the failed write is not silently present",
  );
}

// ---------------------------------------------------------------------------

try {
  rmSync(DATA_DIR, { recursive: true, force: true });
} catch {
  /* same Windows handles this suite is about; not worth failing over */
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
