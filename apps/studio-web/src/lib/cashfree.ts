/**
 * Cashfree's checkout, loaded only when someone is about to pay.
 *
 * The script is Cashfree's own (https://sdk.cashfree.com/js/v3/cashfree.js):
 * card and UPI entry happen inside their frame, so no payment detail ever
 * passes through this app. It is injected on demand rather than in
 * index.html, so a visitor reading the landing page never loads it.
 */

interface CashfreeResult {
  error?: { message?: string };
  redirect?: boolean;
  paymentDetails?: { paymentMessage?: string };
}

interface CashfreeInstance {
  checkout(options: { paymentSessionId: string; redirectTarget: '_modal' | '_self' }): Promise<CashfreeResult>;
}

declare global {
  interface Window {
    Cashfree?: (options: { mode: 'sandbox' | 'production' }) => CashfreeInstance;
  }
}

const SDK = 'https://sdk.cashfree.com/js/v3/cashfree.js';
let loading: Promise<void> | null = null;

function loadSdk(): Promise<void> {
  if (window.Cashfree) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SDK;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loading = null;
      reject(new Error('The payment page could not be loaded. Check your connection and try again.'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

export type CheckoutOutcome = 'finished' | 'closed' | 'redirecting';

/**
 * Open Cashfree's checkout in a popup over the page.
 *
 * "finished" means the customer reached the end of the flow, which is not
 * the same as paid -- the caller always asks the server, which asks
 * Cashfree. "redirecting" happens in in-app browsers that cannot show a
 * popup; Cashfree then returns to the payment's return URL.
 */
export async function openCheckout(paymentSessionId: string, mode: 'sandbox' | 'production'): Promise<CheckoutOutcome> {
  await loadSdk();
  if (!window.Cashfree) throw new Error('The payment page could not be loaded.');
  const result = await window.Cashfree({ mode }).checkout({ paymentSessionId, redirectTarget: '_modal' });
  if (result.redirect) return 'redirecting';
  if (result.paymentDetails) return 'finished';
  return 'closed';
}
