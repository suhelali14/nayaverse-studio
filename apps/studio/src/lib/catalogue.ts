/**
 * What Studio sells, at what price, in which languages. Defined once.
 *
 * ── Why this file exists ────────────────────────────────────────────────
 *
 * Until this module, the same facts lived in three places: the plan limits
 * in `apps/studio-api/src/config/plans.ts`, the prices and feature lines in
 * `apps/studio-web/src/lib/plans.ts`, and the dub rate and language list in
 * `dubbing.ts` here. The dub price alone was written out three times. They
 * were held together by a test that read one file off disk to compare it
 * with another -- which catches drift after the fact, in CI, rather than
 * making it impossible.
 *
 * The reason given for the copies was that the API could not import the
 * web app without pulling React into a server. True, and an argument for a
 * third place both can import, not for two copies. This is that place: no
 * dependencies, no runtime, data and types only. The engine already plays
 * this role for `scenes.ts`, which the API and the editor share in the
 * same way.
 *
 * ── Who reads it, and how ───────────────────────────────────────────────
 *
 *   - the API derives the limits it enforces from `PLANS`, and serves the
 *     whole catalogue at `GET /api/catalogue`;
 *   - the web app renders prices, plans and languages from that response,
 *     not from a bundled copy, so changing a price is a server deploy and
 *     not a frontend rebuild;
 *   - `dubbing.ts` reads the dub rate and the language list from here.
 *
 * ── Every number traces somewhere ───────────────────────────────────────
 *
 * Prices and allowances trace to `apps/studio/docs/PRICING.md`, which
 * cites its sources. A feature that is not built is marked `soon` and is
 * never listed as included.
 */

export const REGIONS = ['IN', 'WORLD'] as const;
export type Region = (typeof REGIONS)[number];

export interface RegionInfo {
  readonly id: Region;
  readonly label: string;
  /** The symbol prices in this region are written with. */
  readonly currency: string;
  /** ISO 4217, what a payment in this region is charged in. */
  readonly currencyCode: string;
  /** For `Intl.NumberFormat`: Indian digit grouping for rupees. */
  readonly locale: string;
  /** Sales tax charged on top of a listed price, as a fraction. */
  readonly taxRate: number | null;
  /** The tax's own name, for "plus 18% GST". */
  readonly taxName: string | null;
  /** One line under a price list saying what its prices are. */
  readonly priceNote: string;
}

export const REGION_INFO: readonly RegionInfo[] = [
  {
    id: 'IN',
    label: 'India',
    currency: '₹',
    currencyCode: 'INR',
    locale: 'en-IN',
    taxRate: 0.18,
    taxName: 'GST',
    priceNote: 'Indian prices, before GST.',
  },
  {
    id: 'WORLD',
    label: 'Rest of world',
    currency: '$',
    currencyCode: 'USD',
    locale: 'en-US',
    taxRate: null,
    taxName: null,
    priceNote: 'Prices outside India, in US dollars.',
  },
];

/**
 * What the tools people compare this to charge, quoted honestly.
 *
 * Real published list prices, and the figures in this catalogue most
 * likely to go stale: `apps/studio/docs/PRICING.md` records that the
 * sources found disagreed with each other. So they are shown with the
 * caveat to go and check, never as a table our column happens to win.
 */
export interface Comparison {
  readonly name: string;
  readonly price: string;
  readonly note: string;
}

export const COMPARISONS: readonly Comparison[] = [
  { name: 'OpusClip', price: '$15 – $29 / month', note: 'clips cut from long video' },
  {
    name: 'Submagic',
    price: '$19 – $69 / month, per member',
    note: 'captions and clips; per-member is the part that grows',
  },
  { name: 'HeyGen', price: '$29 – $149 / month', note: 'generated avatars and translation' },
];

export const PLAN_IDS = ['starter', 'creator', 'studio'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface PlanLine {
  readonly label: string;
  /** False renders as a dimmed row, never as a tick. */
  readonly included: boolean;
  /** Shown as a "coming soon" chip. Honest beats aspirational. */
  readonly soon?: boolean;
  readonly detail?: string;
}

export interface Plan {
  readonly id: PlanId;
  readonly name: string;
  readonly pitch: string;
  /** Whole rupees and whole dollars; minor units are not used. */
  readonly price: Readonly<Record<Region, number>>;
  /** Reels scripted, cut and captioned per month. A hard cap. */
  readonly reels: number;
  /** Minutes of lip-synced dubbing included per month. Metered beyond. */
  readonly dubMinutes: number;
  readonly channels: number;
  /** Requests to the AI writer (Write, Tighten, Ideas) per rolling day. */
  readonly aiRequestsPerDay: number;
  /**
   * Seconds of AI-generated video per calendar month. A provider charges
   * per second generated (Runway Gen-4.5: 12 credits, $0.12, a second),
   * moderated attempts included, so this is a hard cap, not a soft one.
   */
  readonly videoSecondsPerMonth: number;
  readonly highlight?: boolean;
  readonly lines: readonly PlanLine[];
}

/**
 * What a minute of dubbing costs past the included allowance.
 *
 * The margin this leaves against the dearest eligible provider is checked
 * by `pricingHolds()` in `dubbing.ts`, so lowering it below cost fails a
 * test rather than a month's accounts.
 */
export const METERED = {
  dubMinute: { IN: 199, WORLD: 3.5 },
} as const satisfies { dubMinute: Readonly<Record<Region, number>> };

/**
 * A feature row.
 *
 * One wording note, because it was got wrong once: until a speech
 * recogniser is wired up, real word timings are not flowing through the
 * caption engine, so these rows say captions come from the script rather
 * than claiming word-level timing a customer cannot get today.
 */
const line = (label: string, included = true, extra: Partial<PlanLine> = {}): PlanLine => ({
  label,
  included,
  ...extra,
});

function overageText(rate: { readonly IN: number; readonly WORLD: number }): string {
  return `then ₹${rate.IN} / $${rate.WORLD.toFixed(2)} a minute`;
}

// Marked pure so a bundle that never reads the plans can drop them, and the
// prices with them: the web app reads prices from the API, and a module-
// level call the bundler cannot prove harmless kept a copy in its bundle.
const dubOverage = /*#__PURE__*/ overageText(METERED.dubMinute);

export const PLANS: readonly Plan[] = [
  {
    id: 'starter',
    name: 'Starter',
    pitch: 'One channel, and enough reels to find out whether this works for you.',
    price: { IN: 399, WORLD: 14 },
    reels: 15,
    dubMinutes: 0,
    channels: 1,
    aiRequestsPerDay: 20,
    videoSecondsPerMonth: 0,
    lines: [
      line('15 scripted reels a month'),
      line('Director: script in, cut reel out'),
      line('Auto-subtitles from your script'),
      line('Frame-exact browser editor'),
      line('1 channel'),
      line('Studio watermark on exports'),
      line('Lip-synced dubbing', false, { detail: 'Creator and above' }),
      line('Auto-publish to Instagram', false, { detail: 'Creator and above' }),
    ],
  },
  {
    id: 'creator',
    name: 'Creator',
    // Not "the plan most people stay on": that is a claim about a user
    // base this product does not have. What is true is what it contains.
    pitch: 'Three channels, no watermark, and dubbing minutes included.',
    price: { IN: 999, WORLD: 29 },
    reels: 60,
    dubMinutes: 3,
    channels: 3,
    aiRequestsPerDay: 100,
    videoSecondsPerMonth: 30,
    highlight: true,
    lines: [
      line('60 scripted reels a month'),
      line('Director: script in, cut reel out'),
      line('Auto-subtitles from your script'),
      line('Frame-exact browser editor'),
      line('3 channels'),
      line('No watermark'),
      line('3 minutes of lip-synced dubbing', true, { soon: true, detail: 'not yet live; ' + dubOverage }),
      line('Auto-publish to Instagram', false, { soon: true, detail: 'waiting on Meta app review' }),
      line('Export to Resolve, Premiere, Kdenlive (OTIO)'),
    ],
  },
  {
    id: 'studio',
    name: 'Studio',
    pitch: 'For an agency or a team running several creators at once.',
    price: { IN: 2499, WORLD: 79 },
    reels: 200,
    dubMinutes: 12,
    channels: 10,
    aiRequestsPerDay: 400,
    videoSecondsPerMonth: 120,
    lines: [
      line('200 scripted reels a month'),
      line('Director: script in, cut reel out'),
      line('Auto-subtitles from your script'),
      line('Frame-exact browser editor'),
      line('10 channels'),
      line('No watermark'),
      line('12 minutes of lip-synced dubbing', true, { soon: true, detail: 'not yet live; ' + dubOverage }),
      line('Auto-publish to Instagram', false, { soon: true, detail: 'waiting on Meta app review' }),
      line('Export to Resolve, Premiere, Kdenlive (OTIO)'),
      line('Generated-avatar reels', false, { soon: true, detail: 'metered, not yet live' }),
    ],
  },
];

/** Shown next to the plans, because an honest price list says what is excluded. */
export const PRICING_NOTES: readonly string[] = [
  'Prices exclude GST. Indian customers are charged 18% on top.',
  'A dubbing minute is one minute of finished video in one language. Dubbing the same minute into three languages uses three minutes.',
  'Unused dubbing minutes do not roll over. Reels do not need to — the cap is far above what anyone posts.',
  'Cancel whenever you like. The plan runs to the end of the period you have paid for.',
];

/** A target language, and what can honestly be done with it. */
export interface DubTarget {
  readonly code: string;
  /** In its own script, so a speaker recognises it at a glance. */
  readonly native: string;
  readonly english: string;
  /**
   * Whether a provider can reshape the mouth for this language.
   *
   * False does NOT mean the language is unsupported: it gets a dubbed voice
   * track over the original picture, which is what most creators actually
   * ship. The distinction exists because a tick that quietly means
   * something weaker is how a customer finds out they were misled.
   */
  readonly lipSync: boolean;
  /** Indian languages lead every list this product shows. */
  readonly indian: boolean;
}

/**
 * The canonical list. India-first, because that is this product's market,
 * then the languages a creator exporting outwards actually asks for.
 */
export const DUB_TARGETS: readonly DubTarget[] = [
  { code: 'hi', native: 'हिन्दी', english: 'Hindi', lipSync: true, indian: true },
  { code: 'mr', native: 'मराठी', english: 'Marathi', lipSync: true, indian: true },
  { code: 'ta', native: 'தமிழ்', english: 'Tamil', lipSync: true, indian: true },
  { code: 'te', native: 'తెలుగు', english: 'Telugu', lipSync: true, indian: true },
  { code: 'bn', native: 'বাংলা', english: 'Bengali', lipSync: true, indian: true },
  { code: 'gu', native: 'ગુજરાતી', english: 'Gujarati', lipSync: true, indian: true },
  { code: 'kn', native: 'ಕನ್ನಡ', english: 'Kannada', lipSync: false, indian: true },
  { code: 'ml', native: 'മലയാളം', english: 'Malayalam', lipSync: false, indian: true },
  { code: 'pa', native: 'ਪੰਜਾਬੀ', english: 'Punjabi', lipSync: false, indian: true },
  { code: 'en', native: 'English', english: 'English', lipSync: true, indian: false },
  { code: 'es', native: 'Español', english: 'Spanish', lipSync: true, indian: false },
  { code: 'pt', native: 'Português', english: 'Portuguese', lipSync: true, indian: false },
  { code: 'ar', native: 'العربية', english: 'Arabic', lipSync: true, indian: false },
  { code: 'id', native: 'Bahasa Indonesia', english: 'Indonesian', lipSync: true, indian: false },
];

/** The whole catalogue, as `GET /api/catalogue` serves it. */
export interface Catalogue {
  readonly regions: readonly RegionInfo[];
  readonly plans: readonly Plan[];
  readonly metered: typeof METERED;
  readonly notes: readonly string[];
  readonly languages: readonly DubTarget[];
  readonly comparisons: readonly Comparison[];
}

export const CATALOGUE: Catalogue = {
  regions: REGION_INFO,
  plans: PLANS,
  metered: METERED,
  notes: PRICING_NOTES,
  languages: DUB_TARGETS,
  comparisons: COMPARISONS,
};
