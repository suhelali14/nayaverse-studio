/**
 * The rules a draft is checked against, as packs.
 *
 * ── Why packs and not one list ───────────────────────────────────────
 *
 * The first version of this file hardcoded India's medical advertising
 * rules, because the first user sold clinic software. That is correct for
 * that user and wrong for a bakery, and a platform that applies a
 * practitioner-ethics rule to a bakery's post will be switched off inside a
 * week — taking the rules that mattered with it.
 *
 * So: `always` runs for everyone, because it only catches claims nobody can
 * substantiate. Everything else is opted into per channel, by key, in the
 * workspace file.
 *
 * ── Why checks at all, when the model is also told ───────────────────
 *
 * A prompt that says "never claim a cure" works nearly always, and nearly
 * always is the wrong standard for something that publishes daily without a
 * person reading it. A model complying on 99 drafts in 100 still ships
 * several bad posts a year, and the one that matters is the one nobody saw.
 * The prompt improves the drafts; the check is what stops the bad one.
 *
 * None of this is legal advice, and a pack passing does not make a post
 * lawful. The approval gate is what makes a post safe, because a person took
 * responsibility for it.
 */

export interface Rule {
  readonly id: string;
  readonly pattern: RegExp;
  /** Why this is a problem, in the words a reviewer needs. */
  readonly why: string;
}

export interface RulePack {
  readonly key: string;
  readonly label: string;
  /** Who should opt in. Shown when listing packs. */
  readonly forWhom: string;
  readonly rules: readonly Rule[];
}

/**
 * Claims hygiene. Always on.
 *
 * Every rule here catches a statement that is either unverifiable or
 * trivially falsifiable by a reader. None of them is industry-specific, and
 * none of them is a matter of taste.
 */
export const ALWAYS: RulePack = {
  key: 'always',
  label: 'Claims hygiene',
  forWhom: 'Everyone. Not optional.',
  rules: [
    {
      id: 'invented-metric',
      pattern:
        /\b\d{1,3}(?:\.\d+)?\s?%\s?(?:faster|more|less|better|fewer|increase|reduction|improvement|growth|accurate|efficient)/i,
      why:
        'A performance percentage. If it did not come from a measurement you ' +
        'can produce, it is invented, and an invented number is the easiest ' +
        'thing to be caught on.',
    },
    {
      id: 'superlative',
      pattern:
        /\b(?:the best|number one|no\.?\s?1|world'?s (?:best|leading)|market leader|most trusted|fastest[- ]growing)\b/i,
      why:
        'An unsubstantiated superlative. Most advertising codes treat these ' +
        'as claims requiring evidence.',
    },
    {
      id: 'guaranteed-outcome',
      pattern: /\b(?:guaranteed?|guarantee[sd]?|100%\s+(?:safe|secure|accurate|uptime)|never fails?)\b/i,
      why: 'An absolute promise. Almost nothing is guaranteed, and the exception is the thing that will be quoted back at you.',
    },
    {
      id: 'fake-urgency',
      pattern: /\b(?:only \d+ left|offer ends (?:today|tonight)|last chance|hurry,? limited)\b/i,
      why:
        'Manufactured scarcity. If the deadline is real, name the date; if it ' +
        'is not, this is the line that loses a reader permanently.',
    },
  ],
};

const HEALTH_IN: RulePack = {
  key: 'health-in',
  label: 'Healthcare, India',
  forWhom:
    'Anyone whose content could be read as health guidance, or who sells to ' +
    'practitioners, in India.',
  rules: [
    {
      id: 'cure-claim',
      pattern: /\b(?:cure[sd]?|heals?|remed(?:y|ies)|prevents?|reverses?)\b/i,
      why:
        'Reads as a claim to treat or prevent illness. Advertising suggesting ' +
        'a remedy engages the Drugs and Magic Remedies (Objectionable ' +
        'Advertisements) Act.',
    },
    {
      id: 'medical-advice',
      pattern:
        /\b(?:you should (?:take|use|try)|recommended dose|dosage|\d+\s?mg\b|symptoms? of|self[- ]diagnos)/i,
      why:
        'Guidance a reader could act on medically. That requires a ' +
        'registration, and even then not in an advertisement.',
    },
    {
      id: 'patient-testimonial',
      pattern:
        /\b(?:patients? (?:say|love|told us|report)|our patients?|testimonial|review from a patient)\b/i,
      why:
        'Reads as a patient testimonial. The NMC ethics regulations prohibit a ' +
        'registered practitioner from soliciting or sharing these, so this ' +
        'risks their registration, not only your reputation.',
    },
    {
      id: 'named-practitioner',
      pattern: /\b(?:dr\.?|doctor)\s+[A-Z][a-z]{2,}/,
      why:
        'Names a practitioner. A vendor advertising a named doctor is how ' +
        'prohibited soliciting happens by accident.',
    },
  ],
};

const FINANCE: RulePack = {
  key: 'finance',
  label: 'Financial services',
  forWhom: 'Anyone discussing returns, investments, lending or insurance.',
  rules: [
    {
      id: 'return-promise',
      pattern: /\b(?:assured returns?|guaranteed returns?|risk[- ]free|double your money|fixed \d+%\s*returns?)\b/i,
      why: 'A promised return. Regulators treat this as mis-selling almost everywhere.',
    },
    {
      id: 'no-risk-disclosure',
      pattern: /\b(?:invest now|start investing|buy this stock|multibagger)\b/i,
      why:
        'A solicitation to invest. These generally require a risk disclosure ' +
        'and often a licence, neither of which an automated post carries.',
    },
  ],
};

const FOOD: RulePack = {
  key: 'food',
  label: 'Food and supplements',
  forWhom: 'Anyone selling food, drink or supplements.',
  rules: [
    {
      id: 'health-benefit',
      pattern: /\b(?:detox|boosts? immunity|burns? fat|cures?|clinically proven|chemical[- ]free)\b/i,
      why:
        'A health claim on food. These are separately regulated in most ' +
        'markets and "chemical-free" is not a meaningful statement about ' +
        'anything edible.',
    },
  ],
};

const CLAIMS_B2B: RulePack = {
  key: 'b2b-saas',
  label: 'B2B software',
  forWhom: 'Software companies, especially early ones.',
  rules: [
    {
      id: 'customer-count',
      pattern:
        /\b(?:\d[\d,]*\+?|hundreds|thousands|dozens|many)\s+(?:companies|customers|clients|users|teams|businesses)\b/i,
      why:
        'Implies a customer base. Early companies reach for this and it is ' +
        'checkable by anyone who asks, which is a bad trade.',
    },
    {
      id: 'enterprise-grade',
      pattern: /\b(?:enterprise[- ]grade|bank[- ]grade|military[- ]grade|SOC ?2|ISO ?27001|HIPAA[- ]compliant)\b/i,
      why:
        'A compliance or security claim. If the certification exists, say which ' +
        'and when; if it does not, this is a false statement to a buyer whose ' +
        'job is to check.',
    },
  ],
};

export const PACKS: readonly RulePack[] = [ALWAYS, HEALTH_IN, FINANCE, FOOD, CLAIMS_B2B];

export const packsByKey = new Map(PACKS.map((p) => [p.key, p]));

/** Opt-in packs, for the CLI to list and the workspace file to reference. */
export const optionalPacks = (): readonly RulePack[] => PACKS.filter((p) => p.key !== 'always');
