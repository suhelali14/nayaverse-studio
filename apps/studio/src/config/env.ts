import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * Configuration, validated at boot.
 *
 * Nothing here has a default that silently does the wrong thing. A studio
 * that starts without an Instagram token and discovers it at the moment of
 * publishing has already spent the compute; one that starts without an API
 * key and discovers it after writing a script has wasted the run.
 *
 * So `doctor` checks all of it up front and says which half you have.
 */

// A .env beside the app, loaded by hand rather than with a dependency:
// this is eight lines and dotenv is a supply-chain surface for a local tool.
const loadDotEnv = (): void => {
  try {
    const raw = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      const key = t.slice(0, i).trim();
      // Already-set wins, so a real environment variable beats the file.
      if (process.env[key] === undefined) {
        process.env[key] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // No .env is normal when everything comes from the environment.
  }
};
loadDotEnv();

const schema = z.object({
  /** The brains. Ideation, scripting and translation all go through this. */
  ANTHROPIC_API_KEY: z.string().min(10).optional(),
  /**
   * Model names churn faster than this code will, so it is configurable.
   * Default is the current small-and-fast one: this writes short copy, not
   * essays, and a cheaper model run daily for a year is the right trade.
   */
  STUDIO_MODEL: z.string().default('claude-haiku-5-5'),

  /**
   * Credentials, as JSON, keyed by workspace and then channel.
   *
   *   {"<workspace>": {"<channel>": {"igUserId": "...", "token": "..."}}}
   *
   * Two levels because this is a platform: one tenant's token must not be
   * reachable by another's channel key, and a flat map makes that an
   * accident waiting for a name collision. Kept out of workspace.json
   * deliberately -- that file is meant to be read, corrected and shared,
   * and a long-lived access token does not belong in it.
   */
  STUDIO_CREDENTIALS: z.string().optional(),

  /**
   * What a million tokens costs, for the line `draft` prints at the end.
   *
   * Configuration rather than a constant because a price compiled into a
   * repo goes stale silently, and a stale price is worse than none: it
   * produces a confident monthly projection that is wrong. `doctor` prints
   * the rates in use so a wrong one is visible. These never affect what is
   * billed -- only what this tool reports.
   */
  STUDIO_PRICE_IN_PER_M: z.coerce.number().min(0).default(0.1),
  STUDIO_PRICE_OUT_PER_M: z.coerce.number().min(0).default(0.5),

});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('studio: configuration is not usable\n');
  for (const [k, v] of Object.entries(parsed.error.flatten().fieldErrors)) {
    console.error(`  ${k}: ${(v ?? []).join('; ')}`);
  }
  console.error('\nSee .env.example.');
  process.exit(1);
}

export const env = parsed.data;

export interface InstagramCreds {
  igUserId: string;
  token: string;
}

type CredentialMap = Record<string, Record<string, InstagramCreds>>;

/**
 * Credentials for one channel of one workspace, or null.
 *
 * Returns null rather than throwing on malformed JSON: a bad token should
 * stop a publish, not stop a draft being written. `doctor` is where a
 * misconfiguration is reported.
 */
export function instagramFor(workspace: string, channelKey: string): InstagramCreds | null {
  if (!env.STUDIO_CREDENTIALS) return null;
  try {
    const all = JSON.parse(env.STUDIO_CREDENTIALS) as CredentialMap;
    const c = all[workspace]?.[channelKey];
    return c?.igUserId && c?.token ? c : null;
  } catch {
    return null;
  }
}

/** For `doctor`: is the credentials blob even parseable? */
export function credentialsParse(): { ok: true } | { ok: false; error: string } {
  if (!env.STUDIO_CREDENTIALS) return { ok: true };
  try {
    JSON.parse(env.STUDIO_CREDENTIALS);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
