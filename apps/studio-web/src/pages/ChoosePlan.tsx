import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge, Button, useToast } from '../components/ui';
import { CheckoutPanel } from '../components/checkout';
import { ApiError, api, type BillingState } from '../lib/api';
import { useAuth } from '../lib/auth';
import { WithCatalogue, regionOf, type Plan } from '../lib/catalogue';
import { PlanCard } from './Pricing';
import { Logo } from '../components/chrome';

/**
 * The step between signing up and the app: choose a plan, pay for it.
 *
 * With a payment gateway configured, choosing opens the checkout panel
 * and the plan starts when Cashfree confirms the payment. Without one --
 * development, or a server not yet given its keys -- the plan is recorded
 * directly, and the page says that nothing is charged, because a plan
 * chooser that looked like it took payment and did not would be lying
 * about the one thing a person is entitled to be sure of.
 *
 * The region is not asked for again: it was answered at sign-up and it is
 * on the account.
 */

export default function ChoosePlan() {
  const { account, refresh, logOut } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [billing, setBilling] = useState<BillingState | null | 'unknown'>('unknown');
  const [paying, setPaying] = useState<Plan | null>(null);
  /** Disables the other cards while one test-mode choice is saving. */
  const [pending, setPending] = useState<Plan['id'] | null>(null);

  useEffect(() => {
    api.billing().then(setBilling, () => setBilling(null));
  }, []);

  if (account === null) return null;

  const region = account.region;
  const firstName = account.name.trim().split(/\s+/)[0] ?? account.name;
  const paymentsOn = billing !== 'unknown' && billing !== null && billing.provider !== null;
  const current = account.planId;
  const active = account.paidThrough !== null && account.paidThrough > new Date().toISOString();

  const chooseFree = async (planId: Plan['id']): Promise<void> => {
    setPending(planId);
    try {
      await api.choosePlan(planId);
      // The app is gated on `planId`, so the context has to know before we
      // navigate or the guard bounces us straight back here.
      await refresh();
      navigate('/app', { replace: true });
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'That plan could not be set. Try again.', 'bad');
      setPending(null);
    }
  };

  return (
    <div className="min-h-screen px-5 py-8 sm:px-10">
      <div className="mx-auto w-full max-w-content">
        <div className="flex items-center justify-between gap-4">
          <Link to="/" className="inline-flex rounded-md" aria-label="Studio, home">
            <Logo />
          </Link>
          <div className="flex items-center gap-3 text-sm text-ink-3">
            <span className="hidden sm:inline">{account.email}</span>
            <Button size="sm" variant="ghost" onClick={() => logOut()}>
              Sign out
            </Button>
          </div>
        </div>

        <WithCatalogue>
          {(c) => (
            <>
              <header className="mx-auto mt-12 max-w-2xl text-center">
                <h1 className="display text-balance text-3xl text-ink sm:text-4xl">
                  {paying ? 'Complete your payment' : `Choose a plan, ${firstName}`}
                </h1>
                <p className="mt-3 text-base text-ink-2">
                  {regionOf(c, region).priceNote} Change or cancel any month.
                </p>
                {billing !== 'unknown' && !paymentsOn && (
                  <p className="mt-4 inline-flex items-center gap-2 text-sm text-ink-2">
                    <Badge tone="warn">Test mode</Badge>
                    Payments are not set up on this server, so choosing a plan charges nothing.
                  </p>
                )}
              </header>

              {paying ? (
                <div className="mx-auto mt-10 max-w-md">
                  <CheckoutPanel
                    catalogue={c}
                    plan={paying}
                    region={region}
                    onCancel={() => setPaying(null)}
                    onPaid={async (_account, payment) => {
                      await refresh();
                      toast(`Payment received. ${paying.name} is active until ${new Date(payment.periodEnd ?? '').toLocaleDateString()}.`);
                      navigate('/app', { replace: true });
                    }}
                  />
                </div>
              ) : (
                <ul className="mx-auto mt-10 grid max-w-5xl grid-cols-1 items-stretch gap-4 lg:grid-cols-3">
                  {c.plans.map((plan) => (
                    <PlanCard
                      catalogue={c}
                      key={plan.id}
                      plan={plan}
                      region={region}
                      headingLevel="h2"
                      action={
                        current === plan.id && (active || !paymentsOn) ? (
                          <Button full onClick={() => navigate('/app', { replace: true })}>
                            Continue with {plan.name}
                          </Button>
                        ) : (
                          <Button
                            full
                            variant={plan.highlight === true ? 'primary' : 'secondary'}
                            disabled={billing === 'unknown' || (pending !== null && pending !== plan.id)}
                            onClick={() => (paymentsOn ? setPaying(plan) : chooseFree(plan.id))}
                          >
                            {current === plan.id ? `Renew ${plan.name}` : `Choose ${plan.name}`}
                          </Button>
                        )
                      }
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </WithCatalogue>
      </div>
    </div>
  );
}
