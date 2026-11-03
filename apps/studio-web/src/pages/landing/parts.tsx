import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, cx } from '../../components/ui';
import { bothPrices, cheapestPlan, useCatalogue } from '../../lib/catalogue';

/**
 * The furniture the landing sections share.
 *
 * It lives beside the sections rather than in `components/ui.tsx` because
 * none of it is a product primitive. A marketing band has no second caller,
 * and promoting it would invite the dashboard to inherit a heading scale
 * chosen for a stranger reading the page for the first time.
 *
 * There is no eyebrow label above the headings. A small tracked caption
 * over every h2 is the most recognisable tic of generated landing pages,
 * and a heading that needs a label to explain it is the wrong heading.
 */

export function Band({
  id,
  labelledBy,
  children,
  tone = 'ground',
}: {
  id?: string;
  labelledBy: string;
  children: ReactNode;
  /** `muted` sets a band on the off-white, so the page has a rhythm. */
  tone?: 'ground' | 'muted';
}) {
  // `.shell` carries the side gutter, so every band agrees on where the
  // page edge is. The anchor offset is handled globally by scroll-padding-top.
  return (
    <section id={id} aria-labelledby={labelledBy} className={tone === 'muted' ? 'bg-panel-2' : 'bg-ground'}>
      <div className="shell py-20 sm:py-28">{children}</div>
    </section>
  );
}

export function Head({
  id,
  title,
  lede,
  soon,
  centred,
}: {
  id: string;
  title: string;
  lede?: ReactNode;
  /** Marks a feature that is designed but not yet switched on. */
  soon?: boolean;
  centred?: boolean;
}) {
  return (
    <header className={cx('max-w-2xl', centred && 'mx-auto text-center')}>
      <h2 id={id} className="display text-balance text-3xl text-ink sm:text-4xl">
        {title}
        {soon === true && (
          <span className="ml-3 inline-flex align-middle">
            <Badge tone="warn">Coming soon</Badge>
          </span>
        )}
      </h2>
      {lede !== undefined && <p className="mt-4 text-pretty text-lg leading-relaxed text-ink-2">{lede}</p>}
    </header>
  );
}

/**
 * A link that looks like a button.
 *
 * Nesting `Button` inside `Link` hands a keyboard two stops for one
 * destination. Taking the inner button out of the tab order keeps the
 * shared styling and leaves the one stop a visitor expects.
 */
export function CtaLink({
  to,
  children,
  variant = 'secondary',
  full,
}: {
  to: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'inverse';
  full?: boolean;
}) {
  return (
    <Link to={to} className={cx('inline-flex rounded-md', full === true && 'w-full')}>
      <Button variant={variant} size="lg" tabIndex={-1} full={full}>
        {children}
      </Button>
    </Link>
  );
}

/**
 * "Plans from ₹399 / $14 a month, plus GST."
 *
 * Read from the served catalogue, so the cheapest plan, both currencies and
 * the tax are all the server's figures. Renders nothing until they arrive:
 * a line reading "from ₹—" would tell a visitor there is no price.
 */
export function FromPrice({ children }: { children: (price: string, tax: string | null) => ReactNode }) {
  const { catalogue } = useCatalogue();
  if (!catalogue) return null;
  const low = cheapestPlan(catalogue);
  if (!low) return null;
  const taxed = catalogue.regions.find((r) => r.taxName !== null);
  return <>{children(bothPrices(catalogue, low.price), taxed?.taxName ?? null)}</>;
}

/** A product capture in a quiet frame, used beside the feature copy. */
export function Shot({ src, alt, width, height, className }: {
  src: string;
  alt: string;
  width: number;
  height: number;
  className?: string;
}) {
  return (
    <figure className={cx('m-0 overflow-hidden rounded-xl border border-line-strong bg-ink shadow-frame', className)}>
      <img src={src} alt={alt} width={width} height={height} loading="lazy" className="block h-auto w-full" />
    </figure>
  );
}
