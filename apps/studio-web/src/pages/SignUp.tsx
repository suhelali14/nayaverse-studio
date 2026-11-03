import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Field, Input, cx } from '../components/ui';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useCatalogue, type Region } from '../lib/catalogue';
import { Logo } from '../components/chrome';
import editorShot from '../assets/product/editor.jpg';

/**
 * The right half of the sign-in and sign-up screens on a desk: the product
 * itself, as a real capture of the editor, rather than an illustration.
 */
function AuthVisual() {
  return (
    <div className="relative hidden overflow-hidden bg-ink lg:block" aria-hidden="true">
      <div className="absolute inset-x-12 top-16">
        <p className="max-w-md text-2xl font-semibold leading-snug tracking-[-0.02em] text-ground">
          From script to a captioned reel, in one editor.
        </p>
        <p className="mt-3 max-w-md text-sm text-ground/60">
          Scenes, matched footage and word-timed captions, in English and Indian languages.
        </p>
      </div>
      <img
        src={editorShot}
        alt=""
        width={1440}
        height={900}
        className="absolute left-12 top-60 w-[150%] max-w-none rounded-xl border border-white/10 shadow-frame"
      />
    </div>
  );
}

/**
 * Creating an account.
 *
 * ── Three decisions worth recording ──────────────────────────────────
 *
 * **Validation runs on blur and on submit, never on every keystroke.**
 * Telling somebody their email is invalid while they are three characters
 * into typing it is a form arguing with a person who is already doing what
 * it asked. The rule a field has is stated in its hint before it is typed
 * in, so failing is the second time you hear about it, not the first.
 *
 * **The double-submit guard is on the submit handler and it is a ref.**
 * Pressing Enter in a text field submits a form without going anywhere near
 * the button's own click guard, and a second submit event in the same tick
 * would still read the old value of a state flag. So the guard is
 * synchronous and the state flag only drives the spinner.
 *
 * **The server's own message is what gets shown.** `ApiError` carries it,
 * and `ApiError.field` says which input it belongs to. "Something went
 * wrong" where the server said "that email is already registered" wastes
 * the one piece of information the person needed.
 *
 * `AuthShell` and `PasswordInput` live here and are imported by LogIn: two
 * sign-in screens whose furniture has drifted apart is the defect a visitor
 * notices first.
 */

const MIN_PASSWORD = 10;

const ID = {
  name: 'signup-name',
  email: 'signup-email',
  password: 'signup-password',
} as const;

/**
 * Deliberately loose. A strict email pattern rejects addresses that are
 * perfectly valid, and the only honest test of an address is whether mail
 * sent to it arrives. This catches a missing @ and a bare domain, which is
 * the whole category of typo a person wants caught before they wait for an
 * email that is never coming.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Values {
  readonly name: string;
  readonly email: string;
  readonly password: string;
}

type TextField = keyof Values;
type Errors = Partial<Record<TextField, string>>;

const ORDER: readonly TextField[] = ['name', 'email', 'password'];

function validate(v: Values): Errors {
  const errors: Errors = {};

  if (v.name.trim() === '') errors.name = 'We need a name to put on the account.';

  const email = v.email.trim();
  if (email === '') errors.email = 'An email address goes here.';
  else if (!EMAIL_SHAPE.test(email))
    errors.email = 'That does not look like an email address — check the @ and the domain.';

  if (v.password === '') errors.password = 'A password goes here.';
  else if (v.password.length < MIN_PASSWORD)
    // Says how far off it is. "Password too short" makes you count.
    errors.password = `That is ${v.password.length} characters and the minimum is ${MIN_PASSWORD}.`;

  return errors;
}

// ---------------------------------------------------------------------------
// Shared furniture for the three signed-out screens.

/** No marketing nav on a sign-in form: there is one thing to do here. */
export function AuthShell({
  title,
  lede,
  children,
  footer,
}: {
  title: string;
  lede?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="flex flex-col px-5 py-8 sm:px-10">
        <Link to="/" className="inline-flex self-start rounded-md" aria-label="Studio, home">
          <Logo />
        </Link>
        <div className="mx-auto flex w-full max-w-[24rem] flex-1 flex-col justify-center py-10">
          <h1 className="display text-2xl text-ink">{title}</h1>
          {lede !== undefined && <p className="mt-2 text-sm leading-relaxed text-ink-2">{lede}</p>}
          <div className="mt-7">{children}</div>
          {footer !== undefined && <div className="mt-6 text-sm text-ink-2">{footer}</div>}
        </div>
      </div>
      <AuthVisual />
    </div>
  );
}

const Eye = ({ slashed }: { slashed: boolean }) => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    className="h-5 w-5"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M2.6 12S6.1 6 12 6s9.4 6 9.4 6-3.5 6-9.4 6-9.4-6-9.4-6Z" />
    <circle cx="12" cy="12" r="2.7" />
    {slashed && <path d="M4 20 20 4" />}
  </svg>
);

export function PasswordInput({
  id,
  value,
  autoComplete,
  invalid,
  onChange,
  onBlur,
}: {
  id: string;
  value: string;
  /** No default: a sign-up and a sign-in field want opposite answers, and
   *  getting this wrong is how a manager saves the wrong password. */
  autoComplete: 'new-password' | 'current-password';
  invalid?: boolean;
  onChange: (next: string) => void;
  onBlur?: () => void;
}) {
  const [shown, setShown] = useState(false);

  return (
    <div className="relative">
      <Input
        id={id}
        type={shown ? 'text' : 'password'}
        value={value}
        autoComplete={autoComplete}
        invalid={invalid}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        // Edge draws its own reveal eye inside a password input, which would
        // sit on top of ours and give the field two of them.
        className="pr-12 [&::-ms-reveal]:hidden"
      />
      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        // 44px of hit area on a 40px field: it overhangs by two pixels at
        // top and bottom, which nobody sees and a thumb appreciates.
        className="absolute right-0.5 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-md text-ink-3 hover:text-ink"
      >
        <Eye slashed={shown} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function SignUp() {
  const { signUp } = useAuth();
  const navigate = useNavigate();

  const [values, setValues] = useState<Values>({ name: '', email: '', password: '' });
  const { catalogue } = useCatalogue();
  // The catalogue lists its home region first, and that is the default.
  const [region, setRegion] = useState<Region | null>(null);
  const chosen: Region | null = region ?? catalogue?.regions[0]?.id ?? null;
  const [touched, setTouched] = useState<Partial<Record<TextField, boolean>>>({});
  const [failure, setFailure] = useState<{ message: string; field?: string } | null>(null);

  const guard = useRef(false);
  const [busy, setBusy] = useState(false);

  const errors = validate(values);

  const edit = (field: TextField) => (next: string) => {
    setValues((v) => ({ ...v, [field]: next }));
    // An error that sits there while you are fixing it reads as nagging. It
    // comes back on blur, or on the next submit.
    setTouched((t) => (t[field] === true ? { ...t, [field]: false } : t));
    setFailure((f) => (f?.field === field ? null : f));
  };

  const blur = (field: TextField) => () => setTouched((t) => ({ ...t, [field]: true }));

  const errorFor = (field: TextField): string | null => {
    if (failure?.field === field) return failure.message;
    return touched[field] === true ? (errors[field] ?? null) : null;
  };

  // A server error that belongs to no input, or to one this form does not
  // render, still has to be read somewhere.
  const summary =
    failure !== null && !ORDER.some((f) => f === failure.field) ? failure.message : null;

  const onSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (guard.current) return;

    const found = validate(values);
    const firstBad = ORDER.find((f) => found[f] !== undefined);
    if (firstBad !== undefined) {
      setTouched({ name: true, email: true, password: true });
      setFailure(null);
      // Put the caret where the work is. The `Input` primitive does not
      // forward a ref and rewriting a shared primitive is not this screen's
      // job, so the field is found by the id it was labelled with.
      const el = document.getElementById(ID[firstBad]);
      if (el instanceof HTMLElement) el.focus();
      return;
    }

    // The regions come from the catalogue. Until it has loaded there is no
    // honest default to send, so the form says so rather than guessing.
    if (chosen === null) {
      setFailure({ message: 'Still loading the regions we price in. Try again in a moment.' });
      return;
    }

    guard.current = true;
    setBusy(true);
    try {
      // signUp stores the token itself, so the next screen is already signed in.
      await signUp({
        name: values.name.trim(),
        email: values.email.trim(),
        password: values.password,
        region: chosen,
      });
      navigate('/choose-plan', { replace: true });
    } catch (err) {
      const api = err instanceof ApiError ? err : null;
      setFailure({
        message:
          api?.message ??
          'We could not reach the server. Check your connection and try again — nothing was created.',
        ...(api?.field !== undefined ? { field: api.field } : {}),
      });
      guard.current = false;
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Create your account"
      lede="You choose a plan on the next step."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="text-accent underline underline-offset-2">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-1">
        <Field label="Name" htmlFor={ID.name} error={errorFor('name')}>
          <Input
            id={ID.name}
            name="name"
            type="text"
            value={values.name}
            autoComplete="name"
            autoCapitalize="words"
            placeholder="Asha Kulkarni"
            invalid={errorFor('name') !== null}
            onChange={(e) => edit('name')(e.target.value)}
            onBlur={blur('name')}
          />
        </Field>

        <Field label="Email" htmlFor={ID.email} error={errorFor('email')}>
          <Input
            id={ID.email}
            name="email"
            type="email"
            value={values.email}
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            inputMode="email"
            placeholder="you@example.com"
            invalid={errorFor('email') !== null}
            onChange={(e) => edit('email')(e.target.value)}
            onBlur={blur('email')}
          />
        </Field>

        <Field
          label="Password"
          htmlFor={ID.password}
          // The rule, up front. Nobody should learn the minimum by failing it.
          hint={`At least ${MIN_PASSWORD} characters.`}
          error={errorFor('password')}
        >
          <PasswordInput
            id={ID.password}
            value={values.password}
            autoComplete="new-password"
            invalid={errorFor('password') !== null}
            onChange={edit('password')}
            onBlur={blur('password')}
          />
        </Field>

        <fieldset className="mt-1">
          <legend className="mb-1.5 text-sm font-medium text-ink">Billing region</legend>
          <div className="grid grid-cols-2 gap-2">
            {(catalogue?.regions ?? []).map(({ id: r, label, currency }) => (
              <label
                key={r}
                className={cx(
                  'flex min-h-[44px] cursor-pointer items-center gap-2.5 rounded-md border px-3 text-sm transition-colors',
                  chosen === r
                    ? 'border-ink bg-panel text-ink'
                    : 'border-line-strong bg-panel text-ink-2 hover:border-ink-3 hover:text-ink',
                )}
              >
                <input
                  type="radio"
                  name="region"
                  value={r}
                  checked={chosen === r}
                  onChange={() => setRegion(r)}
                  className="h-4 w-4"
                />
                <span className="flex-1">{label}</span>
                <span className="text-xs text-ink-3">{currency}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {/* Always in the tree, so filling it is an update a screen reader
            announces rather than a region that appears from nowhere. */}
        <p
          aria-live="polite"
          className={cx('mt-4 text-sm leading-relaxed text-bad', summary === null && 'sr-only')}
        >
          {summary ?? ''}
        </p>

        <Button
          type="submit"
          variant="primary"
          size="lg"
          full
          // Not an async onClick: Enter in a text field submits the form
          // without a click, so the one handler that always runs owns the
          // guard and hands the button its pending state.
          busy={busy}
          className="mt-3"
        >
          Create account
        </Button>
      </form>
    </AuthShell>
  );
}
