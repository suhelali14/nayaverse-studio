import type { Channel, ContextPack } from '../domain/workspace.js';
import { ALWAYS, packsByKey, type Rule } from '../packs/rules.js';

/**
 * Checking a draft against the rules this channel is subject to.
 *
 * Three sources, in order of how specific they are to the user:
 *
 *   1. `always` — claims nobody can substantiate. Not optional.
 *   2. The packs the channel opted into, by key.
 *   3. The things this particular business said it must not claim, and the
 *      things it said do not exist yet. Compiled from the workspace file.
 *
 * The third is the one that makes this a platform rather than a linter. A
 * user writes "we don't have an iOS app" once, and no post ever promises
 * one — without anybody writing a regular expression.
 */

export interface Violation {
  readonly rule: string;
  readonly pack: string;
  readonly matched: string;
  readonly why: string;
}

/**
 * Words too common to carry a prohibition on their own.
 *
 * A user's entry is written as English, not as a pattern, so "a gluten free
 * range" arrives with words that would fire on anything. These are dropped
 * before the rest become the matcher.
 */
const STOPWORDS = new Set([
  'about', 'after', 'again', 'their', 'there', 'these', 'those', 'which',
  'while', 'would', 'could', 'should', 'other', 'range', 'thing', 'things',
  'range', 'option', 'options', 'service', 'services', 'feature', 'features',
  'offer', 'offers', 'available', 'support', 'anything', 'everything',
]);

/**
 * A phrase from a user's own list, as a pattern.
 *
 * ── Why this matches words and not the phrase ────────────────────────
 *
 * The first version required the user's phrase verbatim, and a bakery that
 * listed "nationwide shipping" under `doesNotExist` sailed past a draft
 * saying "we ship nationwide". That is the failure that matters most,
 * because this is the one rule class a user writes themselves and therefore
 * the one they trust.
 *
 * A prohibition is about a subject, not a word order. So the distinctive
 * words become the matcher and any one of them is enough.
 *
 * ── Why over-matching is the right direction ─────────────────────────
 *
 * "gluten" will hold a post that merely mentions gluten, which is a false
 * hold. That costs a reviewer a glance. The other error ships a claim the
 * business told us never to make. Those are not symmetrical, so this errs
 * toward holding, and a held post can always be approved.
 */
function phraseRule(phrase: string, id: string, why: string): Rule | null {
  const cleaned = phrase.trim().toLowerCase();
  if (cleaned.length < 3) return null;

  const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Hyphens and slashes separate words as much as spaces do: somebody
  // writing "gluten-free" means the same as "gluten free".
  const words = cleaned
    .split(/[\s/_-]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}+#]/gu, ''))
    .filter((w) => w.length >= 5 && !STOPWORDS.has(w));

  // A short entry with nothing distinctive left -- "SMS", "C++", "organic"
  // after stopwording -- falls back to the whole thing, on word boundaries,
  // so a deliberately terse entry still works.
  const alternatives = words.length > 0 ? words : [cleaned];

  return {
    id,
    pattern: new RegExp(`\\b(?:${alternatives.map(esc).join('|')})`, 'i'),
    why,
  };
}

function rulesFor(channel: Channel, context: ContextPack): { rule: Rule; pack: string }[] {
  const out: { rule: Rule; pack: string }[] = [];

  for (const r of ALWAYS.rules) out.push({ rule: r, pack: ALWAYS.key });

  for (const key of channel.rulePacks) {
    const pack = packsByKey.get(key);
    if (!pack) continue; // reported by `doctor`, not thrown mid-draft
    for (const r of pack.rules) out.push({ rule: r, pack: pack.key });
  }

  // The user's own two lists.
  context.mustNotClaim.forEach((phrase, i) => {
    const r = phraseRule(
      phrase,
      `must-not-claim-${i + 1}`,
      `You listed this as something this business must not claim: "${phrase}".`,
    );
    if (r) out.push({ rule: r, pack: 'workspace' });
  });

  context.doesNotExist.forEach((phrase, i) => {
    const r = phraseRule(
      phrase,
      `does-not-exist-${i + 1}`,
      `You listed this as not built yet: "${phrase}". Promising it is how a ` +
        'renewal conversation goes badly.',
    );
    if (r) out.push({ rule: r, pack: 'workspace' });
  });

  return out;
}

/**
 * Everything wrong with a draft, rather than the first thing.
 *
 * All of it at once: a reviewer wants the whole list, and fixing one rule
 * only to discover the next is how an approval gate becomes the thing people
 * route around.
 */
export function check(text: string, channel: Channel, context: ContextPack): Violation[] {
  const out: Violation[] = [];
  const seen = new Set<string>();
  for (const { rule, pack } of rulesFor(channel, context)) {
    const m = rule.pattern.exec(text);
    if (!m) continue;
    // One finding per rule, even where the phrase repeats.
    if (seen.has(rule.id)) continue;
    seen.add(rule.id);
    out.push({ rule: rule.id, pack, matched: m[0], why: rule.why });
  }
  return out;
}

/** For `doctor`: how many rules this channel is actually subject to. */
export function ruleCount(channel: Channel, context: ContextPack): number {
  return rulesFor(channel, context).length;
}

/** Pack keys named in a workspace that this build does not have. */
export function unknownPacks(channel: Channel): string[] {
  return channel.rulePacks.filter((k) => !packsByKey.has(k));
}
