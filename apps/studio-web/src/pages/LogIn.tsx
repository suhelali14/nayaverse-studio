import { useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Button, Field, Input, cx } from '../components/ui';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { AuthShell, PasswordInput } from './SignUp';

/**
 * Signing in.
 *
 * ── Two decisions worth recording ────────────────────────────────────
 *
 * **There is no "forgot password" link.** No endpoint resets a password, so
 * a link would lead to a page that cannot exist. A dead link on the one
 * screen people reach when they are already stuck is worse than no link:
 * it costs them a click and the hope that came with it.
 *
 * **The `from` path is checked before it is followed.** `RequireAccount`
 * puts the route the visitor was heading for into router state, which is
 * the right thing to honour; but state is also the easiest place to plant
 * an off-site URL, so only a same-site path is accepted.
 */

const ID = { email: 'login-email', password: 'login-password' } as const;

/** Accepts `/app/p/42`; rejects `https://elsewhere`, `//elsewhere` and junk. */
const safePath = (value: unknown): string | null =>
  typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : null;

export default function LogIn() {
  const { logIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<{ message: string; field?: string } | null>(null);

  const guard = useRef(false);
  const [busy, setBusy] = useState(false);

  const from = safePath((location.state as { from?: unknown } | null)?.from);

  // Sign-in asks no questions about the shape of what you typed: the server
  // is the only thing that knows whether this pair is right, and a form
  // that quibbles about an email it is about to send anyway is just in the
  // way. Empty is the one case worth catching here.
  const missing = email.trim() === '' || password === '';

  const errorFor = (field: 'email' | 'password'): string | null => {
    if (failure?.field === field) return failure.message;
    if (!touched) return null;
    if (field === 'email' && email.trim() === '') return 'An email address goes here.';
    if (field === 'password' && password === '') return 'A password goes here.';
    return null;
  };

  const summary =
    failure !== null && failure.field !== 'email' && failure.field !== 'password'
      ? failure.message
      : null;

  const onSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    // Enter in a text field never touches the button's own click guard, so
    // the guard lives here, and it is a ref because two submits in one tick
    // would both read a stale state flag.
    if (guard.current) return;

    if (missing) {
      setTouched(true);
      setFailure(null);
      const el = document.getElementById(email.trim() === '' ? ID.email : ID.password);
      if (el instanceof HTMLElement) el.focus();
      return;
    }

    guard.current = true;
    setBusy(true);
    try {
      const account = await logIn({ email: email.trim(), password });
      // Finish the journey they were on, otherwise the dashboard -- or the
      // plan chooser, which the dashboard is gated behind anyway.
      navigate(from ?? (account.planId !== null ? '/app' : '/choose-plan'), { replace: true });
    } catch (err) {
      const api = err instanceof ApiError ? err : null;
      setFailure({
        message:
          api?.message ?? 'We could not reach the server. Check your connection and try again.',
        ...(api?.field !== undefined ? { field: api.field } : {}),
      });
      guard.current = false;
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Sign in"
      footer={
        <>
          No account yet?{' '}
          <Link to="/signup" className="text-accent underline underline-offset-2">
            Create one
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-1">
        <Field label="Email" htmlFor={ID.email} error={errorFor('email')}>
          <Input
            id={ID.email}
            name="email"
            type="email"
            value={email}
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            inputMode="email"
            autoFocus
            invalid={errorFor('email') !== null}
            onChange={(e) => {
              setEmail(e.target.value);
              setFailure((f) => (f?.field === 'email' ? null : f));
            }}
            onBlur={() => setTouched(true)}
          />
        </Field>

        <Field label="Password" htmlFor={ID.password} error={errorFor('password')}>
          <PasswordInput
            id={ID.password}
            value={password}
            autoComplete="current-password"
            invalid={errorFor('password') !== null}
            onChange={(next) => {
              setPassword(next);
              setFailure((f) => (f?.field === 'password' ? null : f));
            }}
            onBlur={() => setTouched(true)}
          />
        </Field>

        {/* Always in the tree, so filling it is an update a screen reader
            announces rather than a region that appears from nowhere. */}
        <p
          aria-live="polite"
          className={cx('mt-3 text-sm leading-relaxed text-bad', summary === null && 'sr-only')}
        >
          {summary ?? ''}
        </p>

        <Button type="submit" variant="primary" size="lg" full busy={busy} className="mt-3">
          Sign in
        </Button>
      </form>
    </AuthShell>
  );
}
