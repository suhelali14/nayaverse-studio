import { useCallback, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { SitePage } from '../components/chrome';
import { Badge, Button, Panel, cx } from '../components/ui';
import {
  WithCatalogue,
  formatMoney,
  regionOf,
  taxLine,
  type Catalogue,
  type Plan,
  type PlanLine,
  type Region,
  type RegionInfo,
} from '../lib/catalogue';

/**
 * The price list.
 *
 * ── Two decisions worth recording ────────────────────────────────────
 *
 * **Nothing on this page is a literal.** Every price, cap, feature row and
 * note is read from `GET /api/catalogue`, which serves
 * `apps/studio/src/lib/catalogue.ts`, which cites its own arithmetic. A
 * pricing page with a number typed into the markup is a pricing page that
 * will disagree with the billing screen within a month.
 *
 * **`PlanCard` lives here rather than in a shared component file**, because
 * the card's authoritative home is the page a stranger reads first. The
 * plan chooser imports it from here: that screen is reached only after
 * signing up, where a slightly larger download costs nothing, whereas the
 * page every visitor loads should carry nothing it does not use.
 */

const REGION_KEY = 'studio.pricing.region';

// localStorage throws outright in a private window, so both halves are
// guarded and a failure degrades to "the page forgets your choice".
const readStoredRegion = (regions: readonly RegionInfo[]): Region => {
  try {
    const stored = localStorage.getItem(REGION_KEY);
    const known = regions.find((x) => x.id === stored);
    if (known) return known.id;
  } catch {
    /* no storage: the default below is a perfectly good answer */
  }
  // The catalogue lists its home region first.
  return regions[0]!.id;
};

const storeRegion = (region: Region): void => {
  try {
    localStorage.setItem(REGION_KEY, region);
  } catch {
    /* see above */
  }
};

// ---------------------------------------------------------------------------
// The plan card, shared with ChoosePlan.

const Tick = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" className="mt-[3px] h-4 w-4 shrink-0 text-accent">
    <path
      d="M3 8.4l3.3 3.3L13 5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * One feature row.
 *
 * Three states, not two. `included: false` is dimmed and struck, `soon` is
 * dimmed with a chip and never struck -- it is unbuilt, not withheld -- and
 * neither is ever allowed to render as a tick. Generated-avatar reels are
 * the live example: the catalogue marks them `soon`, so this is the code
 * that stops the Studio plan advertising a feature nobody can use yet.
 */
function Line({ line }: { line: PlanLine }) {
  if (line.soon === true) {
    return (
      <li className="flex items-start gap-2.5 text-sm text-ink-3">
        <span aria-hidden="true" className="mt-[7px] h-1.5 w-1.5 shrink-0 bg-warn/70" />
        <span>
          <span className="sr-only">Not built yet: </span>
          <span className="align-middle">{line.label}</span> <Badge tone="warn">Coming soon</Badge>
          {line.detail !== undefined && (
            <span className="mt-0.5 block text-xs text-ink-3">{line.detail}</span>
          )}
        </span>
      </li>
    );
  }

  if (!line.included) {
    return (
      <li className="flex items-start gap-2.5 text-sm text-ink-3">
        <span aria-hidden="true" className="mt-[10px] h-px w-3.5 shrink-0 bg-ink-3" />
        <span>
          <span className="sr-only">Not included: </span>
          <span>{line.label}</span>
          {line.detail !== undefined && (
            <span className="mt-0.5 block text-xs text-ink-3">{line.detail}</span>
          )}
        </span>
      </li>
    );
  }

  return (
    <li className="flex items-start gap-2.5 text-sm text-ink-2">
      <Tick />
      <span>
        <span className="sr-only">Included: </span>
        {line.label}
        {line.detail !== undefined && (
          <span className="mt-0.5 block text-xs text-ink-3">{line.detail}</span>
        )}
      </span>
    </li>
  );
}

export interface PlanCardProps {
  readonly catalogue: Catalogue;
  readonly plan: Plan;
  readonly region: Region;
  /** The footer control: a link to sign up here, a submit button in the chooser. */
  readonly action: ReactNode;
  /** Whichever level follows the heading above the card on this page. */
  readonly headingLevel?: 'h2' | 'h3';
}

/** Renders as an `<li>`, so the caller supplies the surrounding list. */
export function PlanCard({ catalogue, plan, region, action, headingLevel = 'h3' }: PlanCardProps) {
  const Heading = headingLevel;
  const price = plan.price[region];
  const tax = taxLine(regionOf(catalogue, region));

  return (
    <Panel
      as="li"
      className={cx(
        'flex flex-col rounded-xl p-6',
        // Emphasis by halo and chip rather than by a different border
        // colour: the other two cards keep every edge they had, so nothing
        // looks broken next to the one being pointed at.
        plan.highlight === true && 'shadow-frame ring-1 ring-ink',
      )}
    >
      <div className="flex min-h-[26px] flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <Heading className="text-base font-semibold text-ink">{plan.name}</Heading>
        {/* A design emphasis stated as a fact about the plan. This product
            has no customers yet, so it cannot have a popular plan, and a
            "73% choose this" chip would be a straight invention. */}
        {plan.highlight === true && <Badge tone="accent">Recommended</Badge>}
      </div>

      <p className="mt-4 flex items-baseline gap-1.5">
        <span className="tabular text-3xl font-semibold leading-none text-ink">
          {formatMoney(catalogue, region, price)}
        </span>
        <span className="text-sm text-ink-3">/ month</span>
      </p>
      {/* Always rendered, so three cards keep their rhythm when only one
          region adds a tax line. */}
      <p className="mt-1.5 min-h-[1.05rem] text-xs text-ink-3">
        {tax ?? ''}
      </p>

      <p className="mt-3 text-sm leading-relaxed text-ink-2">{plan.pitch}</p>

      <ul className="mt-5 flex flex-col gap-2.5">
        {plan.lines.map((l) => (
          <Line key={l.label} line={l} />
        ))}
      </ul>

      {/* mt-auto on a wide screen, so the buttons line up across cards whose
          feature lists are different lengths. */}
      <div className="mt-6 pt-1 lg:mt-auto">{action}</div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------

function RegionToggle({
  regions,
  value,
  onChange,
}: {
  regions: readonly RegionInfo[];
  value: Region;
  onChange: (next: Region) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Show prices for"
      className="inline-flex rounded-md border border-line-strong bg-panel p-1"
    >
      {regions.map(({ id: r, label }) => (
        <button
          key={r}
          type="button"
          aria-pressed={value === r}
          onClick={() => onChange(r)}
          className={cx(
            'flex min-h-[44px] items-center justify-center px-4 text-sm font-medium transition-colors sm:h-9 sm:min-h-0',
            value === r ? 'rounded bg-ink text-ground' : 'text-ink-2 hover:text-ink',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Faq({ q, children }: { q: string; children: ReactNode }) {
  return (
    <details className="group border-b border-line">
      <summary className="flex min-h-[52px] cursor-pointer list-none items-center justify-between gap-4 py-3 text-base font-medium text-ink [&::-webkit-details-marker]:hidden">
        {q}
        <span
          aria-hidden="true"
          className="shrink-0 text-lg leading-none text-ink-3 transition-transform group-open:rotate-45"
        >
          +
        </span>
      </summary>
      <div className="max-w-prose pb-5 text-sm leading-relaxed text-ink-2">{children}</div>
    </details>
  );
}

export default function Pricing() {
  return (
    <SitePage>
      <WithCatalogue fallback={<div className="shell min-h-[60vh] pt-16" />}>
        {(c) => <PricingBody c={c} />}
      </WithCatalogue>
    </SitePage>
  );
}

function PricingBody({ c }: { c: Catalogue }) {
  const [region, setRegion] = useState<Region>(() => readStoredRegion(c.regions));
  const pickRegion = useCallback((next: Region) => {
    setRegion(next);
    storeRegion(next);
  }, []);

  const info = regionOf(c, region);
  const lipSynced = c.languages.filter((l) => l.lipSync).length;
  const dubRate = formatMoney(c, region, c.metered.dubMinute[region]);
  const tax = c.regions.find((r) => r.taxRate !== null);

  return (
    <>
      <section className="shell pt-14 text-center sm:pt-20">
        <h1 className="display mx-auto max-w-2xl text-balance text-4xl text-ink sm:text-5xl">Pricing</h1>
        <p className="mx-auto mt-4 max-w-xl text-lg leading-relaxed text-ink-2">
          Monthly plans for making reels. Dubbing is billed by the minute, only when you use it.
        </p>
        <div className="mt-8 flex flex-col items-center gap-2">
          <RegionToggle regions={c.regions} value={region} onChange={pickRegion} />
          <p className="text-xs text-ink-3">{info.priceNote}</p>
        </div>
      </section>

      <section aria-label="Plans" className="shell mt-10">
        <ul className="mx-auto grid max-w-5xl grid-cols-1 items-stretch gap-4 lg:grid-cols-3">
          {c.plans.map((plan) => (
            <PlanCard
              catalogue={c}
              key={plan.id}
              plan={plan}
              region={region}
              headingLevel="h2"
              action={
                <Link to="/signup" className="block rounded-md" tabIndex={-1}>
                  <Button full variant={plan.highlight === true ? 'primary' : 'secondary'}>
                    Start with {plan.name}
                  </Button>
                </Link>
              }
            />
          ))}
        </ul>
      </section>

      <section aria-labelledby="dubbing-price" className="shell mt-16">
        <div className="mx-auto grid max-w-5xl gap-8 rounded-xl border border-line bg-panel-2 p-6 sm:p-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <div>
            <div className="flex items-center gap-2">
              <h2 id="dubbing-price" className="text-lg font-semibold text-ink">
                Dubbing
              </h2>
              <Badge tone="warn">Coming soon</Badge>
            </div>
            <p className="mt-3 flex items-baseline gap-1.5">
              <span className="tabular text-3xl font-semibold leading-none tracking-[-0.02em] text-ink">{dubRate}</span>
              <span className="text-sm text-ink-3">per minute, per language</span>
            </p>
            <p className="mt-3 text-sm leading-relaxed text-ink-2">
              Counted on finished video. A minute dubbed into three languages is three minutes.
            </p>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-ink">
              {c.languages.length} languages · {lipSynced} with lip-sync
            </h3>
            <ul className="mt-3 flex flex-wrap gap-1.5">
              {c.languages.map((l) => (
                <li key={l.code} className="rounded-md border border-line-strong bg-panel px-2.5 py-1 text-sm text-ink">
                  <span lang={l.code}>{l.native}</span>
                  {l.lipSync && (
                    <span className="ml-1.5 text-2xs font-semibold text-good" title="Lip-sync">
                      LS
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-ink-3">LS: lip movement is matched to the new voice.</p>
          </div>
        </div>
      </section>

      <section aria-labelledby="faq" className="shell mt-20 pb-24">
        <div className="mx-auto grid max-w-5xl gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
          <h2 id="faq" className="display text-3xl text-ink">
            Questions
          </h2>
          <div className="border-t border-line">
            <Faq q="What counts as a reel?">
              One finished vertical video. Your allowance and what you have used are on the Plan &amp;
              billing page inside Studio.
            </Faq>
            <Faq q="What is a dubbing minute?">
              One minute of finished video in one language. Unused included minutes do not roll over.
              Beyond them the rate is {dubRate} a minute.
            </Faq>
            {tax && tax.taxName !== null && tax.taxRate !== null && (
              <Faq q={`Is ${tax.taxName} included?`}>
                No. Prices exclude {tax.taxName}; customers in {tax.label} pay{' '}
                {Math.round(tax.taxRate * 100)}% on top.
              </Faq>
            )}
            <Faq q="How do I pay?">
              With UPI, a card or net banking, through Cashfree, when you choose a plan. Studio never
              sees or stores your card details.
            </Faq>
            <Faq q="Can I cancel?">
              Yes, from the Plan &amp; billing page. The plan runs to the end of the period you have paid
              for.
            </Faq>
            <Faq q="What happens if I go over?">
              Reels are a monthly allowance that resets each period. Dubbing beyond the included
              minutes is billed at the per-minute rate and shown on your usage page.
            </Faq>
            {c.notes.length > 0 && (
              <Faq q="The full terms">
                <ul className="space-y-2">
                  {c.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </Faq>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
