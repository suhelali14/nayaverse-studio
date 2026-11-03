import type { Channel, ContextPack, Workspace } from '../domain/workspace.js';
import type { Shot } from '../lib/store.js';
import { HOOKS, hooksByKey } from '../packs/hooks.js';
import { asJson, type Ledger, type Model } from './model.js';

/**
 * The roles, and why there are exactly these.
 *
 * ── What earns a separate call ───────────────────────────────────────
 *
 * A role exists where the job is genuinely different judgement, not where
 * a pipeline diagram would look fuller. Three tests it has to pass:
 *
 *   1. Does it need different instructions? Hook writing and body writing
 *      have different rules; asking for both at once gets the average.
 *   2. Is its output worth rejecting on its own? A premise can be thrown
 *      away for the price of one short call, before a script is paid for.
 *   3. Does splitting it buy a choice? The hooksmith returns six and a
 *      critic picks one. One call returning one hook has nothing to pick.
 *
 * ── What is deliberately NOT a role ──────────────────────────────────
 *
 * Editing, assembly, the rule check and publishing are code, and turning
 * them into agents would make all four worse. A model that renders is a
 * slower, dearer, less reliable ffmpeg; a model that checks rules is the
 * thing the rules exist to compensate for. The split that matters in this
 * codebase is unchanged: models decide, code refuses and executes.
 */

export interface RoleContext {
  readonly workspace: Workspace;
  readonly channel: Channel;
  readonly language: string;
}

const contextBlock = (c: ContextPack): string => {
  const out = [`WHAT THIS BUSINESS IS\n${c.what}`];
  out.push(`\nWHAT EXISTS AND WORKS\n${c.whatWorks.map((w) => `- ${w}`).join('\n')}`);
  if (c.doesNotExist.length) {
    out.push(
      `\nWHAT DOES NOT EXIST YET — never imply any of these\n${c.doesNotExist
        .map((w) => `- ${w}`)
        .join('\n')}`,
    );
  }
  if (c.mustNotClaim.length) {
    out.push(`\nCLAIMS THIS BUSINESS MUST NOT MAKE\n${c.mustNotClaim.map((w) => `- ${w}`).join('\n')}`);
  }
  if (c.pricing) out.push(`\nCOMMERCIAL TERMS\n${c.pricing}`);
  if (c.voice) out.push(`\nVOICE\n${c.voice}`);
  return out.join('\n');
};

const audienceBlock = (ch: Channel): string =>
  [
    `Platform: ${ch.platform}`,
    `Handle: ${ch.handle}`,
    `What a follower gets: ${ch.promise}`,
    `Speaking to: ${ch.audience.who}${ch.audience.region ? ` in ${ch.audience.region}` : ''}`,
    `They are trying to: ${ch.audience.jobToBeDone}`,
    ...(ch.audience.misconception
      ? [`They currently wrongly believe: ${ch.audience.misconception}`]
      : []),
    `Subjects this account covers:\n${ch.beats.map((b) => `- ${b}`).join('\n')}`,
  ].join('\n');

// ---------------------------------------------------------------------------
// 1. Strategist — what is worth saying today, and which hooks suit it.

export interface Brief {
  premise: string;
  forWhom: string;
  angle: string;
  archetypes: string[];
}

export async function strategist(
  model: Model,
  led: Ledger,
  ctx: RoleContext,
  avoid: readonly string[],
): Promise<Brief> {
  const system = `ROLE: strategist

You choose what a social account should post next. You do not write the post.

${contextBlock(ctx.workspace.context)}

THIS ACCOUNT
${audienceBlock(ctx.channel)}

HOOK ARCHETYPES AVAILABLE
${HOOKS.map((h) => `- ${h.key}: ${h.shape}`).join('\n')}

Pick one idea. It must be something this business can actually stand behind
today, drawn from what exists and works. Then name the two or three hook
archetypes that genuinely suit it — not all of them, and not the ones that
would need a number nobody can produce.

Return ONLY JSON:
{
  "premise": "one line in English: what this post argues",
  "forWhom": "one line in English: who stops scrolling, and why them",
  "angle": "one line in English: the specific way into it, not the topic",
  "archetypes": ["<key>", "<key>"]
}`;

  const user = avoid.length
    ? `Already used or rejected on this account — propose none of these again:\n${avoid
        .map((a) => `- ${a}`)
        .join('\n')}\n\nChoose the next idea.`
    : 'Nothing has been posted here yet. Open with the single clearest idea.';

  const res = await model.complete(system, user, 700);
  led.record(res);
  const b = asJson<Brief>(res.text, 'strategist');
  if (!b.premise || !b.forWhom) throw new Error('strategist: premise and forWhom are required.');
  // An unknown key would silently drop a candidate later. Filtered here,
  // where the fallback can be stated, rather than producing fewer hooks.
  b.archetypes = (b.archetypes ?? []).filter((k) => hooksByKey.has(k));
  if (b.archetypes.length === 0) b.archetypes = ['curiosity-gap', 'specific-outcome'];
  return b;
}

// ---------------------------------------------------------------------------
// 2. Hooksmith — one opening per archetype, so there is something to choose.

export interface HookCandidate {
  archetype: string;
  line: string;
}

export async function hooksmith(
  model: Model,
  led: Ledger,
  ctx: RoleContext,
  brief: Brief,
): Promise<HookCandidate[]> {
  const chosen = brief.archetypes.map((k) => hooksByKey.get(k)!).filter(Boolean);

  const system = `ROLE: hooksmith

You write the first line of a short vertical video. Only the first line.

${contextBlock(ctx.workspace.context)}

THIS ACCOUNT
${audienceBlock(ctx.channel)}

THE IDEA
${brief.premise}
Angle: ${brief.angle}

WRITE ONE HOOK PER ARCHETYPE BELOW
${chosen
  .map(
    (h) =>
      `${h.key}\n  shape: ${h.shape}\n  why it works: ${h.why}\n  example: ${h.example}\n  watch out: ${h.risk}`,
  )
  .join('\n\n')}

RULES
- It is read in under one second, on mute, by someone mid-scroll.
- At most 9 words. Shorter is better.
- Never open with a greeting, a channel intro, or "in this video".
- Never state a percentage, a customer count, or a superlative.
- Write in ${ctx.language}.

Return ONLY JSON:
{ "candidates": [ { "archetype": "<key>", "line": "<the hook>" } ] }`;

  const res = await model.complete(system, 'Write one hook per archetype.', 800);
  led.record(res);
  const parsed = asJson<{ candidates: HookCandidate[] }>(res.text, 'hooksmith');
  const out = (parsed.candidates ?? []).filter((c) => c?.line?.trim());
  if (out.length === 0) throw new Error('hooksmith returned no usable hooks.');
  return out;
}

// ---------------------------------------------------------------------------
// 3. Critic — picks one. Only ever sees hooks that already passed the code check.

export interface Verdict {
  chosen: string;
  why: string;
}

export async function critic(
  model: Model,
  led: Ledger,
  ctx: RoleContext,
  brief: Brief,
  candidates: readonly HookCandidate[],
): Promise<Verdict> {
  const system = `ROLE: critic

You choose between openings for a short vertical video. You do not rewrite them.

Speaking to: ${ctx.channel.audience.who}
They are trying to: ${ctx.channel.audience.jobToBeDone}
The post argues: ${brief.premise}

Judge only on whether this specific person stops scrolling, on mute, in
under a second. Not on which is cleverest, and not on which you would
write. A hook that is true and plain beats one that is interesting and
vague, because the body has to pay the hook back.

CANDIDATES
${candidates.map((c, i) => `${i + 1}. [${c.archetype}] ${c.line}`).join('\n')}

Return ONLY JSON:
{ "chosen": "<the archetype key of the winner>", "why": "one line, in English" }`;

  const res = await model.complete(system, 'Choose one.', 300);
  led.record(res);
  const v = asJson<Verdict>(res.text, 'critic');
  // A critic naming something that was not on the list has not chosen.
  if (!candidates.some((c) => c.archetype === v.chosen)) {
    throw new Error(`critic chose "${v.chosen}", which was not a candidate.`);
  }
  return v;
}

// ---------------------------------------------------------------------------
// 4. Scriptwriter — the body, built to hold attention rather than to inform.

export interface Beat {
  seconds: number;
  caption: string;
  shows: string;
}

export interface ScriptBody {
  beats: Beat[];
  caption: string;
}

export async function scriptwriter(
  model: Model,
  led: Ledger,
  ctx: RoleContext,
  brief: Brief,
  hook: HookCandidate,
): Promise<ScriptBody> {
  const sh = ctx.channel.shape;
  const system = `ROLE: scriptwriter

You write the body of a short vertical video. The opening line is already
chosen and is beat 1 — do not rewrite it.

${contextBlock(ctx.workspace.context)}

THIS ACCOUNT
${audienceBlock(ctx.channel)}

THE POST
Argues: ${brief.premise}
For: ${brief.forWhom}
Angle: ${brief.angle}
Beat 1 is exactly this line: "${hook.line}"

STRUCTURE
- ${sh.minBeats} to ${sh.maxBeats} beats, ${sh.minSecondsPerBeat} to ${sh.maxSecondsPerBeat} seconds each.
- Beat 1 is the hook, already written.
- Beats 2-3 pay the hook back. Whatever it promised or withheld arrives
  here, not at the end. A hook that is still unpaid at ten seconds has lost.
- The middle delivers in pieces, one idea per beat. Change what is on
  screen every beat: a held image is where people leave.
- The last beat earns the next post. A question they answer themselves, or
  what happens next. Not a request to follow.

RULES
- On-screen captions: at most ${sh.maxCaptionWords} words. Read on mute, mid-scroll.
- Never a percentage, a customer count, or a superlative.
- Never imply anything from the "does not exist yet" list.
- Never name a real person or a named third-party organisation.
- Write captions and the post caption in ${ctx.language}.

Return ONLY JSON:
{
  "beats": [
    { "seconds": 3, "caption": "<= ${sh.maxCaptionWords} words", "shows": "what is on screen, in English" }
  ],
  "caption": "the post caption in ${ctx.language}: 2 short lines, then 3 to 5 hashtags"
}`;

  const res = await model.complete(system, 'Write the body.', 1600);
  led.record(res);
  const s = asJson<ScriptBody>(res.text, 'scriptwriter');
  if (!s.beats?.length || !s.caption) throw new Error('scriptwriter returned an incomplete script.');
  return s;
}

// ---------------------------------------------------------------------------
// 5. Art director — beats to shots, and the only role that sees the assets.

export async function artDirector(
  model: Model,
  led: Ledger,
  ctx: RoleContext,
  beats: readonly Beat[],
): Promise<Shot[]> {
  const assets = ctx.workspace.context.assets;

  // Nothing to choose between, so nothing to ask. A call that can only
  // return one answer is a call worth not making.
  if (assets.length === 0) {
    return beats.map((b) => ({
      seconds: b.seconds,
      caption: b.caption,
      source: { kind: 'solid' as const, label: b.shows.split(/\s+/).slice(0, 3).join(' ') },
    }));
  }

  const system = `ROLE: art-director

You decide what each beat of a short video shows. You do not change captions.

ASSETS AVAILABLE — use the path verbatim
${assets
  .map((a) => `- ${a.path} [${a.kind}] — ${a.describes}${a.caution ? `  (careful: ${a.caution})` : ''}`)
  .join('\n')}

BEATS
${beats.map((b, i) => `${i + 1}. (${b.seconds}s) caption: "${b.caption}" — wants to show: ${b.shows}`).join('\n')}

RULES
- Match the source kind to the asset kind: [photo] takes "photo",
  [screenshot] takes "asset".
- A real photograph beats a title card, and the first beat especially:
  a face in the first second is what stops a scroll.
- Use a title card where no asset genuinely fits. A wrong image is worse
  than an honest card.
- Never use an asset whose caution makes it unpublishable here.

Return ONLY JSON, one entry per beat, in order:
{ "shots": [ { "source": { "kind": "photo"|"asset"|"solid", "path": "<if photo/asset>", "label": "<2-4 English words if solid>" } } ] }`;

  const res = await model.complete(system, 'Assign a source to every beat.', 900);
  led.record(res);
  const parsed = asJson<{ shots: { source: Shot['source'] }[] }>(res.text, 'art-director');
  const paths = new Set(assets.map((a) => a.path));

  const shots = beats.map((b, i) => {
    const src = parsed.shots?.[i]?.source;
    // A missing or invented asset would fail at render, six shots in and
    // with a confusing message. Downgraded here, where a reason can be given.
    const usable =
      src &&
      ((src.kind === 'solid' && typeof src.label === 'string' && src.label.trim()) ||
        ((src.kind === 'photo' || src.kind === 'asset') && paths.has(src.path)));
    return {
      seconds: b.seconds,
      caption: b.caption,
      source: usable
        ? src
        : { kind: 'solid' as const, label: b.shows.split(/\s+/).slice(0, 3).join(' ') },
    } as Shot;
  });
  return shots;
}
