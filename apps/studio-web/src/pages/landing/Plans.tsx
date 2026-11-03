import { Check } from 'lucide-react';
import { Badge, cx } from '../../components/ui';
import { WithCatalogue, bothPrices, type Catalogue } from '../../lib/catalogue';
import { Band, CtaLink, Head } from './parts';

/**
 * A summary of the plans, not a second copy of the pricing page.
 *
 * Three figures per plan, both currencies, and a link. Duplicating the full
 * feature matrix here would give two pages that have to be kept in step by
 * hand, and the one that falls behind is always the one a visitor reads.
 *
 * The plans' own `pitch` strings are deliberately **not** rendered. One of
 * them describes where most people end up, and with no customers yet that
 * sentence would be an invented claim about a user base.
 */

export function Plans() {
  return (
    <WithCatalogue fallback={<div className="h-[640px]" />}>
      {(c) => <PlansBand c={c} />}
    </WithCatalogue>
  );
}

function PlansBand({ c }: { c: Catalogue }) {
  const taxed = c.regions.find((r) => r.taxName !== null);
  return (
    <Band id="plans" labelledBy="plans-title">
      <Head
        id="plans-title"
        centred
        title="Simple monthly plans."
        lede={c.regions.map((r) => `${r.currencyCode} for ${r.label}`).join(', ') + '. Change or cancel any month.'}
      />

      <ul className="mx-auto mt-12 grid max-w-5xl gap-4 lg:grid-cols-3">
        {c.plans.map((plan) => (
          <li
            key={plan.id}
            className={cx(
              'flex flex-col rounded-xl border bg-panel p-6',
              plan.highlight === true ? 'border-ink shadow-frame' : 'border-line',
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-base font-semibold text-ink">{plan.name}</h3>
              {plan.highlight === true && <Badge tone="accent">Recommended</Badge>}
            </div>
            <p className="tabular mt-4 text-2xl font-semibold tracking-[-0.02em] text-ink">{bothPrices(c, plan.price)}</p>
            <p className="mt-1 text-xs text-ink-3">per month{taxed?.taxName ? `, plus ${taxed.taxName}` : ''}</p>

            <ul className="mt-6 space-y-2.5 border-t border-line pt-5 text-sm">
              <li className="flex gap-2.5 text-ink">
                <Check aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-accent" strokeWidth={2.5} />
                {plan.reels} reels a month
              </li>
              <li className="flex gap-2.5 text-ink">
                <Check aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-accent" strokeWidth={2.5} />
                {plan.channels} {plan.channels === 1 ? 'channel' : 'channels'}
              </li>
              <li className={cx('flex gap-2.5', plan.dubMinutes === 0 ? 'text-ink-3' : 'text-ink')}>
                <Check
                  aria-hidden="true"
                  className={cx('mt-0.5 h-4 w-4 shrink-0', plan.dubMinutes === 0 ? 'text-ink-3' : 'text-accent')}
                  strokeWidth={2.5}
                />
                {plan.dubMinutes === 0 ? 'Dubbing pay as you go' : `${plan.dubMinutes} min of dubbing`}
              </li>
            </ul>
            <div className="mt-6 pt-1 lg:mt-auto">
              <CtaLink to="/signup" variant={plan.highlight === true ? 'primary' : 'secondary'} full>
                Start with {plan.name}
              </CtaLink>
            </div>
          </li>
        ))}
      </ul>

      <p className="mt-8 text-center text-sm">
        <a href="/pricing" className="font-medium text-ink underline">
          Compare every feature
        </a>
      </p>
    </Band>
  );
}
