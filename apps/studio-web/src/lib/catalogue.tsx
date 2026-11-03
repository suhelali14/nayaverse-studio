import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import type {
  Catalogue,
  Comparison,
  DubTarget,
  Plan,
  PlanId,
  PlanLine,
  Region,
  RegionInfo,
} from '../../../studio/src/lib/catalogue.js';

export type { Catalogue, Comparison, DubTarget, Plan, PlanId, PlanLine, Region, RegionInfo };

/**
 * The catalogue, as the server serves it.
 *
 * ── Why fetched and not imported ────────────────────────────────────────
 *
 * Prices, plans and languages are server data. Importing them into the
 * bundle would mean a price change is a frontend rebuild, and -- the actual
 * failure -- a deployed tab could keep quoting a price the API no longer
 * charges. So every page reads one fetched copy through this provider, and
 * nothing in a component is a price literal.
 *
 * The types come from `apps/studio/src/lib/catalogue.ts` and carry no
 * runtime: `import type` is erased, so the data reaches the browser only
 * through `GET /api/catalogue`.
 *
 * ── One request for the whole app ───────────────────────────────────────
 *
 * Fetched once when the app mounts and shared. The landing page, the plan
 * chooser and the billing screen all need it, often in one visit, and a
 * fetch per page would show a skeleton on every navigation for data that
 * did not change.
 */

interface CatalogueState {
  readonly catalogue: Catalogue | null;
  readonly error: string | null;
  readonly retry: () => void;
}

const Ctx = createContext<CatalogueState | null>(null);

export function CatalogueProvider({ children }: { children: ReactNode }) {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    api
      .catalogue()
      .then((c) => {
        if (alive) setCatalogue(c);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const value = useMemo(() => ({ catalogue, error, retry }), [catalogue, error, retry]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCatalogue(): CatalogueState {
  const state = useContext(Ctx);
  if (!state) throw new Error('useCatalogue must be used inside <CatalogueProvider>.');
  return state;
}

/**
 * Render once the catalogue is here; say so plainly if it cannot be.
 *
 * A pricing page that renders with no prices is worse than one that says
 * it could not load them: a visitor reading "₹—" decides the product has
 * no price. So the page waits, and on failure it states the failure and
 * offers the retry, rather than inventing a fallback figure.
 */
export function WithCatalogue({
  children,
  fallback,
}: {
  children: (catalogue: Catalogue) => ReactNode;
  fallback?: ReactNode;
}) {
  const { catalogue, error, retry } = useCatalogue();
  if (catalogue) return <>{children(catalogue)}</>;
  if (error) {
    return (
      <div role="alert" className="border border-line bg-panel px-4 py-3 text-sm text-ink-2">
        <p className="text-ink">Plans and prices could not be loaded.</p>
        <p className="mt-1 text-ink-3">{error}</p>
        <button
          type="button"
          onClick={retry}
          className="mt-3 min-h-[40px] border border-line-strong px-3 text-sm text-ink hover:bg-panel-2"
        >
          Try again
        </button>
      </div>
    );
  }
  return (
    <>
      {fallback ?? (
        <div role="status" aria-live="polite" className="py-6 text-sm text-ink-3">
          Loading plans and prices…
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Reading it. Small, pure, and the only place prices become strings.

export const regionOf = (c: Catalogue, id: Region): RegionInfo =>
  c.regions.find((r) => r.id === id) ?? c.regions[0]!;

export const planOf = (c: Catalogue, id: string | null | undefined): Plan | undefined =>
  id ? c.plans.find((p) => p.id === id) : undefined;

export const languageOf = (c: Catalogue, code: string): DubTarget | undefined =>
  c.languages.find((l) => l.code.toLowerCase() === code.toLowerCase());

/**
 * A catalogue price, as text.
 *
 * Dollar amounts keep their cents -- 3.5 must read as $3.50 -- while whole
 * rupee prices drop them, because ₹999.00 only adds noise. Grouping follows
 * the region's locale, so a reader in India sees ₹2,499 grouped the Indian
 * way. The symbol is the region's, so a catalogue that one day quotes
 * dirhams does not leave a rupee sign stranded in a component.
 */
export function formatMoney(c: Catalogue, region: Region, amount: number): string {
  const info = regionOf(c, region);
  return (
    info.currency +
    amount.toLocaleString(info.locale, {
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: 2,
    })
  );
}

/** "plus 18% GST", or null where nothing is added to the listed price. */
export const taxLine = (region: RegionInfo): string | null =>
  region.taxRate === null || region.taxName === null
    ? null
    : `plus ${Math.round(region.taxRate * 100)}% ${region.taxName}`;

/** Both regions at once, for pages that do not make a visitor pick a flag first. */
export const bothPrices = (c: Catalogue, amounts: Readonly<Record<Region, number>>): string =>
  c.regions.map((r) => formatMoney(c, r.id, amounts[r.id])).join(' / ');

/** The plan with the lowest price in the first region, for "from ..." lines. */
export const cheapestPlan = (c: Catalogue): Plan | undefined => {
  const first = c.regions[0]?.id ?? 'IN';
  return c.plans.reduce<Plan | undefined>(
    (low, plan) => (low === undefined || plan.price[first] < low.price[first] ? plan : low),
    undefined,
  );
};
