/**
 * Hook archetypes, as data.
 *
 * ── Why these are not just prompt text ───────────────────────────────
 *
 * The same reason the rule packs are data: a model asked to "write a good
 * hook" writes the average of every hook it has seen, and the average hook
 * is a greeting. Naming the archetype, giving it a shape and an example,
 * then asking for one hook PER archetype produces a spread to choose from
 * rather than five rewordings of the same sentence.
 *
 * ── Where these come from ────────────────────────────────────────────
 *
 * These archetypes recur across every short-form scripting guide read for
 * this (sources in docs/SCRIPTING.md). The retention percentages those
 * guides attach to them do not appear here: they are vendor numbers, self
 * reported, measured against unstated baselines. So the archetypes are
 * recorded and the claims are not. Which one works for a given account is
 * a question only that account's own retention data answers.
 */

export interface HookArchetype {
  readonly key: string;
  readonly label: string;
  /** The shape, as an instruction to whoever is writing it. */
  readonly shape: string;
  /** Why it stops a scroll. Written to be argued with. */
  readonly why: string;
  /** A worked example, deliberately from a domain nobody here sells into. */
  readonly example: string;
  /** Where it misfires. Every archetype has a failure mode. */
  readonly risk: string;
}

export const HOOKS: readonly HookArchetype[] = [
  {
    key: 'curiosity-gap',
    label: 'Curiosity gap',
    shape:
      'State that something surprising is true, and withhold exactly one ' +
      'piece of it. The withheld piece must arrive before 10 seconds.',
    why:
      'An unresolved question is uncomfortable, and the cheapest way to ' +
      'resolve it is to keep watching.',
    example: 'The busiest hour at this bakery is not the morning.',
    risk:
      'Withhold too much and it reads as clickbait. The payoff has to land, ' +
      'or the next post from this account is skipped on sight.',
  },
  {
    key: 'contrarian',
    label: 'Contrarian position',
    shape:
      'Name something the audience already believes, then say plainly that ' +
      'it is wrong. Take the position in the first sentence, not the third.',
    why:
      'Disagreement is attention. Someone who thinks you are wrong watches ' +
      'to find out how wrong.',
    example: 'More contacts will not get your product built.',
    risk:
      'Only works if the body defends it. A contrarian hook over a ' +
      'conventional body is the most disappointing shape there is.',
  },
  {
    key: 'pattern-interrupt',
    label: 'Pattern interrupt',
    shape:
      'Open mid-action or mid-sentence, on an image or a statement that ' +
      'does not belong in this feed. Establish nothing.',
    why:
      'The scroll is a rhythm. Something that breaks the rhythm buys a ' +
      'fraction of a second, which is all a hook needs.',
    example: 'This cost me four hundred rupees and three days.',
    risk: 'Interrupting without a reason is noise. Line two pays for line one.',
  },
  {
    key: 'specific-outcome',
    label: 'Specific outcome',
    shape:
      'Lead with a concrete, checkable result and the time it took. Only ' +
      'numbers you can produce evidence for.',
    why:
      'Specificity reads as true where a claim does not. "Thirty days" is ' +
      'believable where "fast" is not.',
    example: 'Thirty days. Ten conversations. Three things actually built.',
    risk:
      'This is the archetype that invents numbers. If the figure did not ' +
      'come from something you can show, pick a different hook.',
  },
  {
    key: 'empathy-callout',
    label: 'Empathy callout',
    shape:
      'Describe the viewer situation in their own words, before offering ' +
      'anything at all. One sentence, with no solution in it.',
    why: 'Being recognised buys attention that being sold to does not.',
    example: 'You have a folder of ideas and nothing shipped out of it.',
    risk:
      'Generic empathy is worse than none. If it could describe anybody, ' +
      'it describes nobody.',
  },
  {
    key: 'cost-reveal',
    label: 'What it actually cost',
    shape:
      'Open on the price, the hours, or the failure. The real number, ' +
      'including the part that is embarrassing.',
    why:
      'Most content shows the result. Showing the cost is rarer, so it is ' +
      'more interesting, and it is the thing competitors will not copy.',
    example: 'I rebuilt this three times before it rendered correctly.',
    risk:
      'Has to stay a fact, not a complaint. Nobody follows an account to ' +
      'watch somebody feel bad.',
  },
];

export const hooksByKey = new Map(HOOKS.map((h) => [h.key, h]));

/**
 * Openings that cost retention, checked after generation.
 *
 * Every guide read for this says the same thing about greetings, and a
 * model trained on a decade of video intros writes one anyway. So this is
 * enforced rather than requested -- the same split as the rule packs: the
 * model proposes, code refuses.
 */
export const DEAD_OPENINGS: readonly { pattern: RegExp; why: string }[] = [
  {
    pattern: /^\s*(hey|hi|hello|yo)\b/i,
    why: 'A greeting. The viewer has not agreed to a conversation yet.',
  },
  {
    pattern: /^\s*(welcome back|what'?s up guys|guys[,!])/i,
    why: 'A channel intro, addressed to an audience that is still deciding.',
  },
  {
    pattern: /^\s*(in this (video|reel)|today (i|we)'?ll|let'?s talk about)/i,
    why:
      'Announcing the subject instead of starting it. The first second goes ' +
      'on throat-clearing.',
  },
  {
    pattern: /^\s*(so|basically|okay so)\b/i,
    why: 'Opening on a filler word reads as unedited.',
  },
  {
    pattern: /\b(like,? comment,? (and )?(share|subscribe)|smash that)\b/i,
    why:
      'A stacked engagement ask. The clearest signal of a low-effort post, ' +
      'and usually the last thing anybody watches.',
  },
];

/** The dead opening a line trips, if any. Checked on the hook, not the body. */
export function deadOpening(line: string): string | null {
  for (const d of DEAD_OPENINGS) if (d.pattern.test(line)) return d.why;
  return null;
}
