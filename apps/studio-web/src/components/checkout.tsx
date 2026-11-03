import { Lock } from 'lucide-react';
import { useState } from 'react';
import { ApiError, api, type Account, type Payment } from '../lib/api';
import { openCheckout } from '../lib/cashfree';
import { formatMoney, regionOf, type Catalogue, type Plan, type Region } from '../lib/catalogue';
import { Button, Field, Input } from './ui';

/**
 * Paying for one month of a plan: the price in full, a phone number, and
 * Cashfree's own checkout.
 *
 * The breakdown is computed from the served catalogue -- price, and the
 * region's tax rate -- which is the same arithmetic the server charges,
 * so the number on the button is the number on the bank statement. The
 * server never takes an amount from here; it prices the plan itself.
 */
export function CheckoutPanel({
  catalogue,
  plan,
  region,
  onPaid,
  onCancel,
}: {
  catalogue: Catalogue;
  plan: Plan;
  region: Region;
  onPaid: (account: Account, payment: Payment) => void;
  onCancel: () => void;
}) {
  const info = regionOf(catalogue, region);
  const subtotal = plan.price[region];
  const tax = info.taxRate ? Math.round(subtotal * info.taxRate * 100) / 100 : 0;
  const total = Math.round((subtotal + tax) * 100) / 100;

  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pay = async () => {
    setError(null);
    setPhoneError(null);
    if (phone.replace(/\D/g, '').length < 10) {
      setPhoneError('Enter a 10-digit mobile number.');
      return;
    }
    setBusy(true);
    try {
      const started = await api.checkout({ planId: plan.id, phone });
      const outcome = await openCheckout(started.paymentSessionId, started.mode);
      if (outcome === 'redirecting') return; // Cashfree takes over the page.
      // Whatever the popup said, the server asks Cashfree.
      const confirmed = await api.confirmPayment(started.payment.id);
      if (confirmed.payment.status === 'paid') {
        onPaid(confirmed.account, confirmed.payment);
        return;
      }
      setError(
        outcome === 'closed'
          ? 'The payment was not completed. You have not been charged.'
          : 'The payment has not gone through yet. If money left your account, it will show here within a few minutes.',
      );
    } catch (e) {
      if (e instanceof ApiError && e.field === 'phone') setPhoneError(e.message);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-line-strong bg-panel p-5 sm:p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold text-ink">{plan.name} plan · 1 month</h2>
        <button type="button" onClick={onCancel} className="text-sm text-ink-2 underline hover:text-ink">
          Change plan
        </button>
      </div>

      <dl className="mt-5 space-y-2 text-sm">
        <div className="flex justify-between">
          <dt className="text-ink-2">Plan</dt>
          <dd className="tabular text-ink">{formatMoney(catalogue, region, subtotal)}</dd>
        </div>
        {tax > 0 && (
          <div className="flex justify-between">
            <dt className="text-ink-2">
              {info.taxName} ({Math.round((info.taxRate ?? 0) * 100)}%)
            </dt>
            <dd className="tabular text-ink">{formatMoney(catalogue, region, tax)}</dd>
          </div>
        )}
        <div className="flex justify-between border-t border-line pt-2 text-base font-semibold">
          <dt className="text-ink">Total today</dt>
          <dd className="tabular text-ink">{formatMoney(catalogue, region, total)}</dd>
        </div>
      </dl>

      <div className="mt-5">
        <Field label="Mobile number" htmlFor="pay-phone" error={phoneError} hint="For your payment receipt and UPI.">
          <Input
            id="pay-phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="98765 43210"
            value={phone}
            invalid={phoneError !== null}
            onChange={(e) => setPhone(e.target.value)}
          />
        </Field>
      </div>

      {error && (
        <p role="alert" className="mb-3 rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">
          {error}
        </p>
      )}

      <Button variant="primary" size="lg" full busy={busy} onClick={pay}>
        <Lock aria-hidden="true" className="h-4 w-4" />
        Pay {formatMoney(catalogue, region, total)}
      </Button>
      <p className="mt-3 text-center text-xs text-ink-3">
        UPI, cards and net banking through Cashfree. Your plan runs for one month from payment.
      </p>
    </div>
  );
}
