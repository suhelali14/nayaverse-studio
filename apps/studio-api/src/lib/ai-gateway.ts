import { AsyncLocalStorage } from "node:async_hooks";
import { CATALOGUE } from "../../../studio/src/lib/catalogue.js";
import { AiUnavailable } from "./ai.js";
import { appendAiUsage, listAiUsage, type AccountRecord } from "./store.js";

/**
 * Every call to an AI model goes through here.
 *
 *   1. allowance   the plan's requests per rolling day, from the catalogue
 *   2. burst       a few a minute per account, whatever the plan, so one
 *                  stuck retry loop in a browser cannot spend a day's budget
 *   3. the call    inside an async context that collects token counts from
 *                  the SDK responses (`reportUsage`), however many requests
 *                  one operation makes -- a plan with one rewrite is two
 *   4. the ledger  one record per operation: kind, model, tokens, time,
 *                  outcome. No prompt text is stored.
 *
 * Authorisation (signed in, plan paid for) happens before this, in
 * `lib/access.ts`; input is cleaned before that, in `plugins/security.ts`;
 * and the model's output is cleaned and validated by the caller after.
 */

export type AiKind = "plan" | "ideas" | "hooks" | "scripts" | "scene" | "edit" | "shot";

export const BURST_PER_MINUTE = 8;
const DAY_MS = 86_400_000;

interface Tokens {
  inputTokens: number;
  outputTokens: number;
}

const context = new AsyncLocalStorage<Tokens>();

/** Called by the model clients after each response. A no-op outside `runAi`. */
export function reportUsage(usage: { input_tokens?: number | null; output_tokens?: number | null } | undefined): void {
  const tokens = context.getStore();
  if (!tokens || !usage) return;
  tokens.inputTokens += usage.input_tokens ?? 0;
  tokens.outputTokens += usage.output_tokens ?? 0;
}

export function dailyAllowance(account: AccountRecord): number {
  return CATALOGUE.plans.find((p) => p.id === account.planId)?.aiRequestsPerDay ?? 0;
}

export async function aiAllowance(account: AccountRecord, now = Date.now()) {
  const since = new Date(now - DAY_MS).toISOString();
  const used = (await listAiUsage(since, account.id)).length;
  return { used, limit: dailyAllowance(account) };
}

const recent = new Map<string, number[]>();

export async function runAi<T>(
  account: AccountRecord,
  kind: AiKind,
  model: string,
  call: () => Promise<T>,
): Promise<T> {
  const { used, limit } = await aiAllowance(account);
  if (used >= limit) {
    throw new AiUnavailable(
      429,
      `You have used today's ${limit} AI requests. They refresh over the next 24 hours, or a larger plan has more.`,
      `daily allowance ${used}/${limit}`,
    );
  }

  const now = Date.now();
  const window = (recent.get(account.id) ?? []).filter((t) => now - t < 60_000);
  if (window.length >= BURST_PER_MINUTE) {
    throw new AiUnavailable(429, "That is a lot of requests in a minute. Wait a moment and try again.", "burst");
  }
  window.push(now);
  recent.set(account.id, window);

  const tokens: Tokens = { inputTokens: 0, outputTokens: 0 };
  const started = Date.now();
  let ok = false;
  let status = 200;
  try {
    const result = await context.run(tokens, call);
    ok = true;
    return result;
  } catch (error) {
    status = error instanceof AiUnavailable ? error.status : 500;
    throw error;
  } finally {
    await appendAiUsage({
      accountId: account.id,
      kind,
      model,
      ok,
      status,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      ms: Date.now() - started,
    });
  }
}

/** Forget the burst windows. For tests, which build many apps in one process. */
export function resetBursts(): void {
  recent.clear();
}
