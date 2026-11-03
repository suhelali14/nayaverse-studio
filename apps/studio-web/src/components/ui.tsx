import clsx from 'clsx';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

/**
 * The primitives every screen in this app is built from.
 *
 * Two of them earn their place by fixing bugs this repo has already
 * shipped once, in the clinic portal:
 *
 *   - `Button` **manages its own pending state**. Pass an async onClick and
 *     it awaits the promise, shows a spinner and blocks re-entry. The
 *     previous audit found 136 buttons, 30 with any guard and zero
 *     spinners, because threading a `saving` boolean through every
 *     component is work nobody does. A button that guards itself is a
 *     button that is always guarded.
 *   - `Field` always renders its own error slot, so a form does not reflow
 *     when validation fails.
 *
 * A control here is a standard control: a button looks like a button, a
 * field like a field, at one corner radius. Red is reserved for the
 * primary action.
 */

export const cx = clsx;

// ---------------------------------------------------------------------------

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'inverse';
type Size = 'xs' | 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';

const VARIANT: Record<Variant, string> = {
  primary:
    'bg-accent text-accent-ink font-semibold hover:bg-accent-deep active:bg-accent-deep ' +
    'disabled:bg-panel-3 disabled:text-ink-3 disabled:hover:bg-panel-3',
  secondary: 'bg-panel-2 text-ink font-medium border border-line-strong hover:bg-panel-3 disabled:opacity-45',
  ghost: 'text-ink-2 font-medium hover:bg-panel-2 hover:text-ink disabled:opacity-45',
  danger: 'text-bad font-medium border border-bad/40 hover:bg-bad-soft disabled:opacity-45',
  // Ink on the light website, for the second action beside a red one.
  inverse: 'bg-ink text-ground font-semibold hover:bg-ink/85 disabled:opacity-45',
};

const SIZE: Record<Size, string> = {
  xs: 'h-7 px-2.5 text-xs',
  sm: 'h-8 px-3 text-sm',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-5 text-base',
  // Square. Its own size rather than md plus overrides: md's px-4 won the
  // cascade over px-0 and squeezed every icon to four pixels wide.
  icon: 'h-9 w-9 p-0',
  'icon-sm': 'h-7 w-7 p-0',
};

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  variant?: Variant;
  size?: Size;
  /** Set by a caller that already tracks its own state. ORed with ours. */
  busy?: boolean;
  full?: boolean;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void | Promise<unknown>;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  busy,
  full,
  className,
  children,
  onClick,
  disabled,
  ...rest
}: ButtonProps) {
  const [pending, setPending] = useState(false);
  // Deleting the row a button lives in is the common case, so a resolved
  // promise must not set state on an unmounted component.
  const alive = useRef(true);
  // Set on mount as well as cleared on unmount. React StrictMode mounts,
  // unmounts and remounts every component in development; a ref that is
  // only ever cleared stays false after that rehearsal, and every async
  // result is then dropped -- which left the dashboard on skeletons for
  // good and every async button spinning after it had finished.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const handle = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (!onClick || pending) return;
      const result = onClick(e);
      if (!(result instanceof Promise)) return;
      setPending(true);
      void result.finally(() => {
        if (alive.current) setPending(false);
      });
    },
    [onClick, pending],
  );

  const waiting = pending || busy === true;
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled === true || waiting}
      aria-busy={waiting || undefined}
      onClick={handle}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md transition-colors duration-150',
        'disabled:cursor-not-allowed',
        VARIANT[variant],
        SIZE[size],
        full && 'w-full',
        className,
      )}
    >
      {waiting && <Spinner />}
      {children}
    </button>
  );
}

/** A square icon-only button. `label` is required: it is the only name it has. */
export function IconButton({
  label,
  children,
  className,
  variant = 'ghost',
  small,
  ...rest
}: Omit<ButtonProps, 'children' | 'size'> & { label: string; children: ReactNode; small?: boolean }) {
  return (
    <Button
      {...rest}
      variant={variant}
      size={small ? 'icon-sm' : 'icon'}
      aria-label={label}
      title={label}
      className={className}
    >
      {children}
    </Button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cx('h-4 w-4 animate-spin', className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------

/** A bordered block with an optional heading row. */
export function Panel({
  children,
  className,
  tab,
  aside,
  as: As = 'div',
}: {
  children: ReactNode;
  className?: string;
  /** The panel's heading. */
  tab?: ReactNode;
  /** Right-hand side of the heading: a count, a small control. */
  aside?: ReactNode;
  as?: 'div' | 'section' | 'article' | 'li';
}) {
  return (
    <As className={cx('rounded-lg border border-line bg-panel', className)}>
      {tab !== undefined && (
        <div className="panel-head">
          <span>{tab}</span>
          {aside !== undefined && <span className="text-xs font-normal text-ink-3">{aside}</span>}
        </div>
      )}
      {children}
    </As>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {/* Always present, so a form does not jump when validation fails. */}
      <p
        className={cx('mt-1 min-h-[1.05rem] text-xs', error ? 'text-bad' : 'text-ink-3')}
        role={error ? 'alert' : undefined}
      >
        {error ?? hint ?? ''}
      </p>
    </div>
  );
}

const CONTROL =
  'w-full rounded-md border bg-panel px-3 text-sm text-ink transition-[border-color,box-shadow] duration-150 ' +
  'hover:border-ink-3 focus:border-select focus:outline-none focus:ring-2 focus:ring-select/25 ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

export function Input({ className, invalid, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      {...rest}
      aria-invalid={invalid === true || undefined}
      className={cx(CONTROL, invalid ? 'border-bad' : 'border-line-strong', 'h-10 py-2', className)}
    />
  );
}

export function Textarea({
  className,
  invalid,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      {...rest}
      aria-invalid={invalid === true || undefined}
      className={cx(CONTROL, invalid ? 'border-bad' : 'border-line-strong', 'resize-y py-2 leading-relaxed', className)}
    />
  );
}

/**
 * A native select, styled from the tokens.
 *
 * Native, because a language list of fourteen scripts is exactly where a
 * custom dropdown loses typeahead, screen-reader support and the phone's
 * own picker. The chevron is drawn, not a glyph.
 */
export function Select({
  className,
  children,
  compact,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { compact?: boolean }) {
  return (
    <span className={cx('relative block', className)}>
      <select {...rest} className={cx(CONTROL, compact ? 'h-8' : 'h-10', 'appearance-none border-line-strong pr-9')}>
        {children}
      </select>
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3"
      >
        <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/**
 * A segmented control: one choice of a few, all visible.
 *
 * Buttons with `aria-pressed` rather than a radio group, because each
 * option acts immediately and several carry their own disabled reason.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { id: T; label: string; disabled?: boolean; title?: string }[];
  value: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex rounded-md bg-panel-2 p-0.5">
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={on}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.id)}
            className={cx(
              // min-w-0 + truncate: a long label shortens with an ellipsis
              // instead of wrapping out of a fixed-height button.
              'h-7 min-w-0 flex-1 truncate rounded px-2 text-xs font-semibold transition-colors duration-150',
              on ? 'bg-panel-3 text-ink' : 'text-ink-2 hover:text-ink',
              'disabled:cursor-not-allowed disabled:text-ink-3 disabled:opacity-60 disabled:hover:text-ink-3',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent';
const TONE: Record<Tone, string> = {
  neutral: 'bg-panel-3 text-ink-2',
  good: 'bg-good-soft text-good',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  accent: 'bg-accent-soft text-accent',
};

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      className={cx(
        'inline-flex h-5 items-center gap-1 whitespace-nowrap rounded px-1.5 text-2xs font-semibold leading-none',
        TONE[tone],
      )}
    >
      {children}
    </span>
  );
}

/**
 * A loading placeholder shaped like the thing it stands in for.
 *
 * A sweep rather than a pulse: a pulse reads as "disabled", a sweep reads
 * as "filling in". `role="status"` with one label, so assistive tech says
 * "loading" once instead of reading out a wall of empty boxes.
 */
export function Skeleton({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <div role="status" aria-label={label} className={cx('relative overflow-hidden rounded-md bg-panel-2', className)}>
      <div className="absolute inset-0 -translate-x-full animate-[sweep_1.4s_infinite] bg-gradient-to-r from-transparent via-panel-3/70 to-transparent" />
      <style>{'@keyframes sweep{100%{transform:translateX(100%)}}'}</style>
    </div>
  );
}

export function Empty({
  title,
  body,
  action,
  icon,
}: {
  title: string;
  body: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-line-strong px-6 py-12 text-center">
      {icon && <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-panel-2 text-ink-2">{icon}</div>}
      <p className="font-semibold text-ink">{title}</p>
      {/* Says what to do, not "no data". */}
      <p className="mx-auto mt-1 max-w-prose text-sm text-ink-2">{body}</p>
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toasts. Errors last longer than confirmations, because a failure has to
// be read and usually acted on, where a success is a glance.

interface Toast {
  readonly id: number;
  readonly text: string;
  readonly tone: 'good' | 'bad';
}

const ToastCtx = createContext<(text: string, tone?: 'good' | 'bad') => void>(() => {});

/** Outside a provider this is a no-op: losing a confirmation is a far
 *  smaller problem than losing the save it was confirming. */
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: 'good' | 'bad' = 'good') => {
    const id = Date.now() + Math.random();
    setItems((prev) => {
      if (prev.some((t) => t.text === text)) return prev; // collapse duplicates
      return [...prev.slice(-3), { id, text, tone }];
    });
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), tone === 'bad' ? 9000 : 3500);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            // Assertive only for errors, so a screen reader is interrupted
            // only when something actually needs attention.
            role={t.tone === 'bad' ? 'alert' : 'status'}
            aria-live={t.tone === 'bad' ? 'assertive' : 'polite'}
            className="pointer-events-auto flex max-w-sm items-start gap-2.5 rounded-lg border border-line-strong bg-panel-2 px-4 py-3 text-sm text-ink shadow-float"
          >
            {t.tone === 'bad' ? (
              <AlertTriangle aria-hidden="true" className="mt-px h-4 w-4 shrink-0 text-bad" />
            ) : (
              <CheckCircle2 aria-hidden="true" className="mt-px h-4 w-4 shrink-0 text-good" />
            )}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
