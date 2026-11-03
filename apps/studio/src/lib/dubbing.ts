import { DUB_TARGETS, METERED, type DubTarget } from './catalogue.js';
import { billedMinutes } from './metering.js';

/**
 * Dubbing and lip-sync: the seam, not the implementation.
 *
 * ── Read this before building on it ──────────────────────────────────
 *
 * **Nothing here performs lip-sync.** Reshaping a speaker's mouth to match
 * new audio is a wav2lip-class generative model; it is a research project
 * with a GPU bill, not a module. Every product that offers it -- HeyGen,
 * Sync, Rask, Pinch -- is either running such a model or paying someone who
 * does, and the honest engineering decision for this product is to call one
 * of them rather than pretend otherwise.
 *
 * So this file is the interface a provider plugs into, the cost model that
 * decides what to charge, and the capability matrix that stops the UI from
 * promising something the provider cannot do. The provider itself is a
 * configuration choice with a credit card attached.
 *
 * ── Why the cost model is the important part ─────────────────────────
 *
 * Dubbing is, by a wide margin, the most expensive thing this product can
 * do. Measured against the rest of the pipeline:
 *
 *   scripted + edited reel   ~₹1.30   per video
 *   auto-subtitles           ~₹0.27   per video
 *   lip-synced dub           ~₹45+    per video, PER LANGUAGE
 *
 * A dub costs roughly thirty-five times the reel it is dubbing. That single
 * ratio is why dubbing is metered rather than bundled, and why a plan that
 * included "unlimited dubbing" would lose money on its first enthusiastic
 * customer. Anyone tempted to simplify the pricing should read that table
 * again first.
 */

// The language list and the dub rate live in `catalogue.ts`, the one
// definition the API serves and the web app renders. Re-exported here so
// every existing import of them from this module keeps working.
export { DUB_TARGETS, type DubTarget } from './catalogue.js';

export const targetFor = (code: string): DubTarget | undefined =>
  DUB_TARGETS.find((t) => t.code === code);

// ---------------------------------------------------------------------------
// What providers charge.

export interface ProviderRate {
  readonly id: string;
  readonly name: string;
  /** USD per minute of finished video, audio only. */
  readonly usdPerMinuteAudio: number | null;
  /** USD per minute with the mouth reshaped. Null when not offered. */
  readonly usdPerMinuteLipSync: number | null;
  /** Where the figure came from, so it can be rechecked. */
  readonly source: string;
  /**
   * Whether anyone on this project has seen this price on the vendor's own
   * page. Every entry below is **false**: these come from comparison
   * articles that disagreed with each other, and several were months old.
   * Confirm before quoting any of them to a customer.
   */
  readonly verifiedAtVendor: boolean;
}

/**
 * Third-party reported rates, as of the research done for this module.
 *
 * Deliberately a table rather than one hard-coded number, because the
 * spread is the finding: audio-only dubbing runs around $0.50/min and
 * lip-synced output ranges from $0.40 to $4.99/min depending on vendor and
 * tier. A margin built on the cheapest of those does not survive switching
 * to the dearest, so `PRICE_PER_MINUTE` below is set against the expensive
 * end on purpose.
 */
export const PROVIDER_RATES: readonly ProviderRate[] = [
  {
    id: 'pinch',
    name: 'Pinch',
    usdPerMinuteAudio: 0.5,
    usdPerMinuteLipSync: 1.0,
    source: 'startpinch.com dubbing API pricing comparison',
    verifiedAtVendor: false,
  },
  {
    id: 'veed',
    name: 'VEED',
    usdPerMinuteAudio: null,
    usdPerMinuteLipSync: 0.4,
    source: 'startpinch.com comparison',
    verifiedAtVendor: false,
  },
  {
    id: 'heygen',
    name: 'HeyGen',
    usdPerMinuteAudio: null,
    // Speed tier; the Precision tier was reported around $4.00.
    usdPerMinuteLipSync: 2.0,
    source: 'startpinch.com comparison',
    verifiedAtVendor: false,
  },
  {
    id: 'sync',
    name: 'Sync (lipsync-2)',
    usdPerMinuteAudio: null,
    usdPerMinuteLipSync: 2.4,
    source: 'vendor comparison articles; not confirmed at sync.so',
    verifiedAtVendor: false,
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs Dubbing v2',
    usdPerMinuteAudio: 2.2,
    // Reported as not offering lip-sync in the Dubbing product.
    usdPerMinuteLipSync: null,
    source: 'startpinch.com comparison; vocaindex',
    verifiedAtVendor: false,
  },
];

/**
 * The most this product will pay a provider, per minute.
 *
 * ── Why a ceiling exists at all ──────────────────────────────────────
 *
 * This number was added because a test caught the price below losing
 * money. At ₹199 a minute, a dub served by the dearest provider in the
 * table ($2.40/min, about ₹214) costs more than it sells for -- and
 * nothing in the code would have noticed, because provider choice and
 * pricing lived in different heads.
 *
 * Two ways out: charge ₹475 a minute so any provider clears, or state
 * what we are willing to pay and price against that. The second is
 * correct, because a provider is a decision we make and a price is a
 * promise to a customer. Raising the price to cover a provider we would
 * never choose means every customer pays for that hypothetical.
 *
 * So: providers above this ceiling are listed, costed, and **not eligible**.
 * Choosing one requires repricing, and `pricingHolds()` below is the check
 * that says so out loud.
 */
export const COST_CEILING_USD_PER_MINUTE = 1.0;

/**
 * What a minute of dubbing is sold for.
 *
 * Against the ceiling above: ₹199 on a ₹89 cost is a 55% margin, and
 * $3.50 on the same is 71%. Both survive the ceiling being hit exactly.
 */
export const PRICE_PER_MINUTE = METERED.dubMinute;

/** Rupees per dollar. Moves; stated rather than buried. */
export const INR_PER_USD = 89;

/** Providers we would actually route to, at the current price. */
export function eligibleProviders(lipSync: boolean): ProviderRate[] {
  return PROVIDER_RATES.filter((r) => {
    const rate = lipSync ? r.usdPerMinuteLipSync : r.usdPerMinuteAudio;
    return rate !== null && rate <= COST_CEILING_USD_PER_MINUTE;
  });
}

/**
 * Does the current price still clear the current ceiling, in both regions?
 *
 * Called by the test suite, and worth calling from a release check: the two
 * numbers are set months apart by different reasoning, and the day they
 * stop agreeing is the day every dub starts losing money quietly.
 */
export function pricingHolds(): { ok: boolean; detail: string } {
  const ceilingInr = COST_CEILING_USD_PER_MINUTE * INR_PER_USD;
  const inMargin = (PRICE_PER_MINUTE.IN - ceilingInr) / PRICE_PER_MINUTE.IN;
  const worldMargin =
    (PRICE_PER_MINUTE.WORLD - COST_CEILING_USD_PER_MINUTE) / PRICE_PER_MINUTE.WORLD;
  const ok = inMargin > 0 && worldMargin > 0;
  return {
    ok,
    detail:
      `India ₹${PRICE_PER_MINUTE.IN} vs ₹${ceilingInr.toFixed(0)} ceiling ` +
      `(${(inMargin * 100).toFixed(0)}% margin); ` +
      `world $${PRICE_PER_MINUTE.WORLD} vs $${COST_CEILING_USD_PER_MINUTE} ` +
      `(${(worldMargin * 100).toFixed(0)}%)`,
  };
}

export interface CostEstimate {
  readonly seconds: number;
  readonly minutesBilled: number;
  readonly costUsdLow: number;
  readonly costUsdHigh: number;
  readonly priceInr: number;
  readonly priceUsd: number;
}

/**
 * What one dub costs to serve and what it sells for.
 *
 * Billed in whole minutes, rounded up, because every provider surveyed does
 * the same and absorbing the rounding on a 20-second reel would mean paying
 * for a minute and charging for a third of one.
 */
export function estimateDub(
  seconds: number,
  lipSync: boolean,
  /**
   * The rate being quoted. Required rather than defaulted: the editor passes
   * the one `GET /api/catalogue` served, so it quotes what it shows, and a
   * default here would put a second copy of the price into the browser
   * bundle -- which is exactly how it was found there.
   */
  price: { readonly IN: number; readonly WORLD: number },
): CostEstimate {
  const minutesBilled = billedMinutes(seconds);
  // Only providers we would actually route to. Costing against one we
  // have ruled out as too expensive makes the margin look worse than it
  // is and hides the real question, which is whether the ceiling is right.
  const rates = eligibleProviders(lipSync)
    .map((r) => (lipSync ? r.usdPerMinuteLipSync : r.usdPerMinuteAudio))
    .filter((n): n is number => n !== null);
  const low = rates.length ? Math.min(...rates) : 0;
  const high = rates.length ? Math.max(...rates) : 0;
  return {
    seconds,
    minutesBilled,
    costUsdLow: low * minutesBilled,
    costUsdHigh: high * minutesBilled,
    priceInr: price.IN * minutesBilled,
    priceUsd: price.WORLD * minutesBilled,
  };
}

/** Does this request make sense before any money is spent on it? */
export function checkDubRequest(input: {
  toLanguage: string;
  lipSync: boolean;
}): { ok: true } | { ok: false; why: string } {
  const target = targetFor(input.toLanguage);
  if (!target) {
    return { ok: false, why: `${input.toLanguage} is not a language this can dub into.` };
  }
  if (input.lipSync && !target.lipSync) {
    return {
      ok: false,
      why:
        `Lip-sync is not available for ${target.english}. A dubbed voice track ` +
        'over the original picture is — ask for that instead.',
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The interface a provider implements.

export interface DubRequest {
  /** The finished reel to dub. A provider needs the cut, not the rushes. */
  readonly videoPath: string;
  readonly fromLanguage: string;
  readonly toLanguage: string;
  readonly lipSync: boolean;
  /**
   * The words to speak, when they are already known.
   *
   * This product has a transcript and a script, so handing the provider the
   * text skips its own recognition step -- which is both cheaper and more
   * accurate than letting it re-listen to audio we already transcribed.
   */
  readonly script?: string;
}

export type DubState = 'queued' | 'running' | 'done' | 'failed';

export interface DubProgress {
  readonly state: DubState;
  /** 0..1, or null when the provider will not say. */
  readonly progress: number | null;
  /** Set once `state` is `done`. */
  readonly outputUrl: string | null;
  /** Set once `state` is `failed`. The provider's own words. */
  readonly error: string | null;
}

/**
 * A dubbing provider.
 *
 * Submit-and-poll rather than a single awaited call, because these jobs run
 * for minutes and an HTTP request that waits that long will be killed by
 * something in between -- a load balancer, a proxy, or a laptop lid.
 */
export interface DubProvider {
  readonly id: string;
  /** Which targets this provider can actually do, which may be fewer. */
  supports(code: string, lipSync: boolean): boolean;
  submit(request: DubRequest): Promise<{ jobId: string }>;
  poll(jobId: string): Promise<DubProgress>;
}

/**
 * The provider used when none is configured.
 *
 * It refuses, with a message that says what to do. The alternative -- a
 * stub that returns a plausible fake result -- is the worse failure: a
 * dubbed video that is silently the original would reach a customer's
 * audience before anyone noticed.
 */
export class NoProvider implements DubProvider {
  readonly id = 'none';
  supports(): boolean {
    return false;
  }
  async submit(): Promise<{ jobId: string }> {
    throw new Error(
      'No dubbing provider is configured. Set STUDIO_DUB_PROVIDER and its API key. ' +
        'See src/lib/dubbing.ts for the interface and PROVIDER_RATES for the options.',
    );
  }
  async poll(): Promise<DubProgress> {
    throw new Error('No dubbing provider is configured.');
  }
}
