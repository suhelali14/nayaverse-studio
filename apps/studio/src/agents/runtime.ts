import { randomUUID } from 'node:crypto';
import type { Channel, Workspace } from '../domain/workspace.js';
import { check, type Violation } from '../lib/guard.js';
import type { Post } from '../lib/store.js';
import { deadOpening } from '../packs/hooks.js';
import { Ledger, type Model } from './model.js';
import {
  artDirector,
  critic,
  hooksmith,
  scriptwriter,
  strategist,
  type Brief,
  type HookCandidate,
  type RoleContext,
} from './roles.js';

/**
 * The pipeline.
 *
 * ── Why this is a function and not an agent ──────────────────────────
 *
 * It is a fixed order with two decision points, and a model asked to
 * orchestrate it would get the order right almost every time -- which is
 * the problem. "Almost every time" in a step that runs daily, unattended,
 * is a bug you find in a published post. The sequence below is the kind of
 * thing code is good at and judgement is not needed for.
 *
 * ── The two places code refuses ──────────────────────────────────────
 *
 * 1. Dead openings are filtered BEFORE the critic sees them. Letting the
 *    model choose and then rejecting its choice wastes the call and, worse,
 *    invites the fix of asking it more nicely. A greeting never reaches a
 *    shortlist here.
 * 2. The rule guard runs on the finished text, exactly as it did before.
 *    More roles writing does not mean fewer checks.
 */

export interface RunTrace {
  readonly role: string;
  readonly detail: string;
}

export interface DraftResult {
  readonly post: Post;
  readonly trace: RunTrace[];
  readonly ledger: Ledger;
  readonly rejectedHooks: { line: string; why: string }[];
}

export async function draftPost(
  model: Model,
  workspace: Workspace,
  channel: Channel,
  language: string,
  avoid: readonly string[],
): Promise<DraftResult> {
  const ctx: RoleContext = { workspace, channel, language };
  const led = new Ledger();
  const trace: RunTrace[] = [];
  const rejectedHooks: { line: string; why: string }[] = [];

  // 1. What is worth saying.
  const brief: Brief = await strategist(model, led, ctx, avoid);
  // The channel decides how wide a shortlist it pays for.
  brief.archetypes = brief.archetypes.slice(0, channel.shape.hookCandidates);
  trace.push({ role: 'strategist', detail: `${brief.premise}  [${brief.archetypes.join(', ')}]` });

  // 2. One opening per archetype.
  const raw = await hooksmith(model, led, ctx, brief);
  trace.push({ role: 'hooksmith', detail: `${raw.length} candidate(s)` });

  // 3. Code refuses, before anyone chooses.
  const alive: HookCandidate[] = [];
  for (const c of raw) {
    const dead = deadOpening(c.line);
    if (dead) rejectedHooks.push({ line: c.line, why: dead });
    else alive.push(c);
  }
  if (alive.length === 0) {
    throw new Error(
      'Every hook opened in a way that costs retention:\n' +
        rejectedHooks.map((r) => `  "${r.line}" — ${r.why}`).join('\n'),
    );
  }
  if (rejectedHooks.length) {
    trace.push({ role: 'guard', detail: `${rejectedHooks.length} hook(s) refused before the critic` });
  }

  // 4. Choose. A shortlist of one needs no call.
  let hook: HookCandidate;
  if (alive.length === 1) {
    hook = alive[0]!;
    trace.push({ role: 'critic', detail: 'skipped — one candidate survived' });
  } else {
    const verdict = await critic(model, led, ctx, brief, alive);
    hook = alive.find((c) => c.archetype === verdict.chosen)!;
    trace.push({ role: 'critic', detail: `${verdict.chosen} — ${verdict.why}` });
  }

  // 5. The body, built around the chosen opening.
  const body = await scriptwriter(model, led, ctx, brief, hook);
  trace.push({ role: 'scriptwriter', detail: `${body.beats.length} beats` });

  // 6. What each beat shows.
  const shots = await artDirector(model, led, ctx, body.beats);
  const withAssets = shots.filter((s) => s.source.kind !== 'solid').length;
  trace.push({ role: 'art-director', detail: `${withAssets}/${shots.length} beats on real assets` });

  // 7. The rule guard, unchanged.
  const text = `${body.caption}\n${shots.map((s) => s.caption).join('\n')}`;
  const violations: Violation[] = check(text, channel, workspace.context);

  const post: Post = {
    id: `${channel.key}-${language}-${randomUUID().slice(0, 8)}`,
    channel: channel.key,
    language,
    status: violations.length ? 'held' : 'draft',
    ...(violations.length ? { violations } : {}),
    premise: brief.premise,
    forWhom: brief.forWhom,
    shots,
    caption: body.caption,
    createdAt: new Date().toISOString(),
  };

  return { post, trace, ledger: led, rejectedHooks };
}
