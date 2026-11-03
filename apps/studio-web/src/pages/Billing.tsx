import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type BillingState, type Payment, type Usage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { WithCatalogue, formatMoney, planOf, regionOf, type Catalogue, type Plan } from '../lib/catalogue';
import { AppShell } from '../components/chrome';
import { CheckoutPanel } from '../components/checkout';
import { Badge, Button, Panel, Skeleton, cx, useToast } from '../components/ui';
import { Meter, errorText, formatDate } from '../components/project-card';

/**
 * Plan, usage, and payments.
 *
 * With a gateway configured, every plan change is a payment for one month
 * of the new plan, starting when the current paid period ends. Without
 * one (test mode) the plan switches directly and the page says nothing is
 * charged.
 *
 * A checkout that could not open as a popup -- an in-app browser, say --
 * returns here with `?payment=<id>`. That id is confirmed with the server,
 * which asks Cashfree, exactly as the popup path does.
 */

export default function Billing() {
  return (
    <AppShell title="Plan & billing">
      <WithCatalogue>{(c) => <BillingBody c={c} />}</WithCatalogue>
    </AppShell>
  );
}

const PAYMENT_TONE: Record<Payment['status'], 'good' | 'neutral' | 'bad' | 'warn'> = {
  paid: 'good',
  created: 'warn',
  failed: 'bad',
  expired: 'neutral',
};
const PAYMENT_LABEL: Record<Payment['status'], string> = {
  paid: 'Paid',
  created: 'Not completed',
  failed: 'Failed',
  expired: 'Expired',
};

function BillingBody({ c }: { c: Catalogue }) {
  const { account, refresh } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();

  const [usage, setUsage] = useState<Usage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [billing, setBilling] = useState<BillingState | null>(null);
  const [paying, setPaying] = useState<Plan | null>(null);

  const mounted = useRef(true);
  // Set on mount as well as cleared on unmount: React StrictMode mounts
  // twice in development, and a ref only ever cleared drops every result.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const [u, b] = await Promise.all([api.usage(), api.billing()]);
      if (!mounted.current) return;
      setUsage(u);
      setBilling(b);
      setUsageError(null);
    } catch (err) {
      if (mounted.current) setUsageError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Back from a checkout that redirected instead of opening a popup.
  useEffect(() => {
    const id = params.get('payment');
    if (!id) return;
    const next = new URLSearchParams(params);
    next.delete('payment');
    setParams(next, { replace: true });
    void (async () => {
      try {
        const confirmed = await api.confirmPayment(id);
        await refresh();
        await load();
        toast(confirmed.payment.status === 'paid' ? 'Payment received. Your plan is active.' : 'That payment was not completed. You have not been charged.', confirmed.payment.status === 'paid' ? 'good' : 'bad');
      } catch (err) {
        toast(errorText(err), 'bad');
      }
    })();
  }, [params, setParams, refresh, load, toast]);

  const region = account?.region ?? 'IN';
  const planId = account?.planId ?? null;
  const current = planOf(c, planId);
  const paymentsOn = billing?.provider != null;
  const paidThrough = account?.paidThrough ?? null;
  const now = new Date().toISOString();
  const lapsed = paymentsOn && (paidThrough === null || paidThrough <= now);

  const switchFree = async (plan: Plan) => {
    try {
      await api.choosePlan(plan.id);
      await refresh();
      await load();
      if (mounted.current) toast('Now on ' + plan.name + '.');
    } catch (err) {
      if (mounted.current) toast(errorText(err), 'bad');
    }
  };

  if (paying) {
    return (
      <div className="mx-auto max-w-md">
        <CheckoutPanel
          catalogue={c}
          plan={paying}
          region={region}
          onCancel={() => setPaying(null)}
          onPaid={async () => {
            await refresh();
            await load();
            setPaying(null);
            toast('Payment received. ' + paying.name + ' is active.');
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* ── Current plan ────────────────────────────────────────────── */}
      <Panel className="p-5 sm:p-6">
        {current === undefined ? (
          <p className="text-sm text-ink-2">No plan yet. Choose one below.</p>
        ) : (
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-ink">{current.name}</h2>
                {!paymentsOn && billing !== null && <Badge tone="warn">Test mode</Badge>}
                {paymentsOn && !lapsed && <Badge tone="good">Active</Badge>}
                {lapsed && <Badge tone="bad">Ended</Badge>}
              </div>
              <p className="mt-1 text-sm text-ink-2">
                <span className="tabular font-medium text-ink">{formatMoney(c, region, current.price[region])}</span> a month
                {regionOf(c, region).taxName ? `, plus ${regionOf(c, region).taxName}` : ''}
              </p>
              <p className="mt-1 text-sm text-ink-3">
                {paymentsOn
                  ? paidThrough
                    ? (lapsed ? 'Ended on ' : 'Paid through ') + formatDate(paidThrough)
                    : 'Not paid yet'
                  : 'Payments are not set up on this server, so nothing is charged.'}
              </p>
            </div>
            {paymentsOn && (
              <Button variant={lapsed ? 'primary' : 'secondary'} onClick={() => setPaying(current)}>
                {lapsed ? 'Renew now' : 'Pay for next month'}
              </Button>
            )}
          </div>
        )}
        {current && (
          <dl className="mt-6 grid gap-3 border-t border-line pt-5 sm:grid-cols-3">
            {[
              ['Reels a month', String(current.reels)],
              ['Dubbing', current.dubMinutes === 0 ? 'Coming soon, pay as you go' : `Coming soon, ${current.dubMinutes} min`],
              ['Channels', String(current.channels)],
            ].map(([term, value]) => (
              <div key={term}>
                <dt className="text-xs text-ink-3">{term}</dt>
                <dd className="tabular mt-0.5 text-sm font-medium text-ink">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </Panel>

      {/* ── Usage ───────────────────────────────────────────────────── */}
      <section aria-labelledby="usage-heading">
        <h2 id="usage-heading" className="mb-3 text-sm font-semibold text-ink">
          This period
        </h2>
        <Panel className="p-5 sm:p-6">
          {usage === null && usageError === null && (
            <div className="space-y-5" aria-hidden="true">
              <Skeleton className="h-4 w-48" label="Loading usage" />
              <Skeleton className="h-1.5 w-full" />
              <Skeleton className="h-1.5 w-full" />
            </div>
          )}
          {usage === null && usageError !== null && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-ink-2">Usage couldn't be loaded. {usageError}</p>
              <Button size="sm" onClick={() => load()}>
                Try again
              </Button>
            </div>
          )}
          {usage !== null && (
            <div className="grid gap-6 md:grid-cols-2">
              <p className="text-xs text-ink-3 md:col-span-2">
                {formatDate(usage.periodStart)} – {formatDate(usage.periodEnd)}
              </p>
              <Meter
                label="Reels"
                readout={usage.reelsUsed + ' / ' + usage.reelsIncluded}
                value={usage.reelsUsed}
                max={usage.reelsIncluded}
                note={Math.max(0, usage.reelsIncluded - usage.reelsUsed) + ' left'}
              />
              <div>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm text-ink-2">Dubbing</span>
                  <Badge tone="warn">Coming soon</Badge>
                </div>
                <p className="mt-2 text-xs text-ink-3">Your plan's minutes start when dubbing launches.</p>
              </div>
            </div>
          )}
        </Panel>
      </section>

      {/* ── Plans ───────────────────────────────────────────────────── */}
      <section aria-labelledby="plans-heading">
        <h2 id="plans-heading" className="mb-3 text-sm font-semibold text-ink">
          Plans
        </h2>
        <ul className="grid gap-3 md:grid-cols-3">
          {c.plans.map((plan) => {
            const isCurrent = plan.id === planId;
            const tooSmall = usage !== null && !isCurrent && plan.reels < usage.reelsUsed;
            return (
              <li
                key={plan.id}
                className={cx('flex flex-col rounded-lg border bg-panel p-4', isCurrent ? 'border-ink-3' : 'border-line')}
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-ink">{plan.name}</h3>
                  {isCurrent && <Badge>Current</Badge>}
                </div>
                <p className="tabular mt-2 text-lg font-semibold text-ink">
                  {formatMoney(c, region, plan.price[region])}
                  <span className="text-xs font-normal text-ink-3"> / month</span>
                </p>
                <p className="mt-1 text-xs text-ink-2">
                  {plan.reels} reels ·{' '}
                  {plan.channels} {plan.channels === 1 ? 'channel' : 'channels'}
                </p>
                {tooSmall && <p className="mt-2 text-xs text-warn">You have made more reels this period than it allows.</p>}
                <div className="mt-4 pt-1 md:mt-auto">
                  {isCurrent && !lapsed ? (
                    <p className="text-xs text-ink-3">Your plan</p>
                  ) : (
                    <Button size="sm" full onClick={() => (paymentsOn ? setPaying(plan) : switchFree(plan))}>
                      {isCurrent ? 'Renew' : 'Switch to ' + plan.name}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {paymentsOn && (
          <p className="mt-3 text-xs text-ink-3">A new plan starts when your current paid month ends.</p>
        )}
      </section>

      {/* ── Payments ────────────────────────────────────────────────── */}
      {paymentsOn && (
        <section aria-labelledby="payments-heading">
          <h2 id="payments-heading" className="mb-3 text-sm font-semibold text-ink">
            Payments
          </h2>
          {billing.payments.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-sm text-ink-3">
              No payments yet.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="bg-panel-2 text-left text-xs text-ink-2">
                  <tr>
                    <th scope="col" className="px-4 py-2.5 font-semibold">Date</th>
                    <th scope="col" className="px-4 py-2.5 font-semibold">Plan</th>
                    <th scope="col" className="px-4 py-2.5 font-semibold">Period</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-semibold">Amount</th>
                    <th scope="col" className="px-4 py-2.5 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {billing.payments.map((p) => (
                    <tr key={p.id} className="border-t border-line">
                      <td className="px-4 py-2.5 text-ink-2">{formatDate(p.createdAt)}</td>
                      <td className="px-4 py-2.5 text-ink">{planOf(c, p.planId)?.name ?? p.planId}</td>
                      <td className="px-4 py-2.5 text-ink-2">
                        {p.periodStart && p.periodEnd ? `${formatDate(p.periodStart)} – ${formatDate(p.periodEnd)}` : '—'}
                      </td>
                      <td className="tabular px-4 py-2.5 text-right text-ink">
                        {new Intl.NumberFormat(regionOf(c, region).locale, { style: 'currency', currency: p.currency }).format(p.amount)}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge tone={PAYMENT_TONE[p.status]}>{PAYMENT_LABEL[p.status]}</Badge>
                        {p.mode === 'sandbox' && <span className="ml-1.5 text-2xs text-ink-3">sandbox</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {c.notes.length > 0 && (
        <details className="group rounded-lg border border-line bg-panel">
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium text-ink [&::-webkit-details-marker]:hidden">
            Terms
            <span aria-hidden="true" className="text-ink-3 transition-transform group-open:rotate-45">
              +
            </span>
          </summary>
          <ul className="space-y-2 border-t border-line px-4 py-3 text-xs leading-relaxed text-ink-3">
            {c.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
