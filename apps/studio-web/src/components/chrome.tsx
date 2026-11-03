import { BarChart3, Clapperboard, CreditCard, Lightbulb, Link2, LogOut, Menu, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { Button, cx } from './ui';
import { useAuth } from '../lib/auth';
import { useCatalogue } from '../lib/catalogue';

/**
 * The furniture: the website's header and footer, and the signed-in shell.
 *
 * Shared rather than duplicated per page, because a nav that differs
 * between two pages is the defect a visitor notices first.
 */

/** The mark alone: a red tile holding a vertical frame -- a reel. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cx('h-6 w-6 shrink-0', className)}>
      <rect width="24" height="24" rx="6" fill="rgb(var(--accent))" />
      <rect x="8" y="4.5" width="8" height="15" rx="2" fill="none" stroke="rgb(var(--accent-ink))" strokeWidth="1.8" />
      <rect x="10.4" y="15.2" width="3.2" height="1.6" rx="0.8" fill="rgb(var(--accent-ink))" />
    </svg>
  );
}

/** The mark and the name, as the header and the shell carry it. */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-2', className)}>
      <Mark />
      <span className="text-lg font-bold tracking-[-0.02em] text-ink">Studio</span>
    </span>
  );
}

/**
 * The header's lower edge, drawn as a timeline ruler with the playhead at
 * how far down the page the reader is. Written to the DOM directly from a
 * frame-throttled scroll listener: a re-render per scroll event would be
 * the most expensive way to move one line.
 */
function ScrollRuler() {
  const head = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const p = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      if (head.current) head.current.style.left = `${p * 100}%`;
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 -bottom-px h-[6px]">
      <div className="ruler absolute inset-x-0 bottom-0 h-[5px]" />
      <span ref={head} className="absolute bottom-0 h-[9px] w-[2px] -translate-x-1/2 rounded-full bg-accent" />
    </div>
  );
}

const SITE_LINKS = [
  { to: '/#features', label: 'Features' },
  { to: '/#captions', label: 'Captions' },
  { to: '/#dubbing', label: 'Dubbing' },
  { to: '/pricing', label: 'Pricing' },
];

export function SiteHeader() {
  const { status, account } = useAuth();
  const [open, setOpen] = useState(false);
  const location = useLocation();

  // A menu that survives navigation is a menu covering the page you just
  // asked for.
  useEffect(() => setOpen(false), [location.pathname, location.hash]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    // Scroll-locked, or the page slides under the finger on a phone.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  const home = account?.planId ? '/app' : '/choose-plan';

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-ground/90 backdrop-blur supports-[backdrop-filter]:bg-ground/75">
      <ScrollRuler />
      <div className="shell flex h-16 items-center justify-between gap-4">
        <Link to="/" aria-label="Studio, home" className="rounded-md">
          <Logo />
        </Link>

        <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
          {SITE_LINKS.map((l) => (
            <a
              key={l.to}
              href={l.to}
              className="rounded-md px-3 py-2 text-sm font-medium text-ink-2 transition-colors hover:text-ink"
            >
              {l.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-2 md:flex">
          {status === 'signed-in' && account ? (
            <Link to={home} tabIndex={-1}>
              <Button variant="inverse" size="sm">
                Open Studio
              </Button>
            </Link>
          ) : (
            <>
              <Link to="/login" tabIndex={-1}>
                <Button variant="ghost" size="sm">
                  Sign in
                </Button>
              </Link>
              <Link to="/signup" tabIndex={-1}>
                <Button variant="inverse" size="sm">
                  Get started
                </Button>
              </Link>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? 'Close menu' : 'Open menu'}
          className="flex h-10 w-10 items-center justify-center rounded-md text-ink hover:bg-panel-2 md:hidden"
        >
          {open ? <X aria-hidden="true" className="h-5 w-5" /> : <Menu aria-hidden="true" className="h-5 w-5" />}
        </button>
      </div>

      {open && (
        <div className="border-t border-line bg-ground md:hidden">
          <nav className="shell flex flex-col py-2" aria-label="Main">
            {SITE_LINKS.map((l) => (
              <a
                key={l.to}
                href={l.to}
                // 44px targets: this is tapped with a thumb.
                className="flex min-h-[44px] items-center border-b border-line text-sm font-medium text-ink-2"
              >
                {l.label}
              </a>
            ))}
            <div className="mt-3 flex gap-2 pb-3">
              {status === 'signed-in' && account ? (
                <Link to={home} className="flex-1" tabIndex={-1}>
                  <Button variant="inverse" full>
                    Open Studio
                  </Button>
                </Link>
              ) : (
                <>
                  <Link to="/login" className="flex-1" tabIndex={-1}>
                    <Button full>Sign in</Button>
                  </Link>
                  <Link to="/signup" className="flex-1" tabIndex={-1}>
                    <Button variant="inverse" full>
                      Get started
                    </Button>
                  </Link>
                </>
              )}
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}

export function SiteFooter() {
  const { catalogue } = useCatalogue();
  const taxed = catalogue?.regions.find((r) => r.taxName !== null);

  return (
    <footer className="border-t border-line bg-panel-2">
      <div className="shell grid gap-10 py-12 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div>
          <Logo />
          <p className="mt-3 max-w-xs text-sm text-ink-2">
            Script, cut, captions and dubbing for vertical video. Made in Kolhapur.
          </p>
        </div>
        <nav className="grid grid-cols-2 gap-x-14 gap-y-2 text-sm" aria-label="Footer">
          <div className="flex flex-col gap-2">
            <span className="font-semibold text-ink">Product</span>
            <a href="/#features" className="text-ink-2 hover:text-ink">
              Features
            </a>
            <Link to="/pricing" className="text-ink-2 hover:text-ink">
              Pricing
            </Link>
            <a href="/#faq" className="text-ink-2 hover:text-ink">
              Questions
            </a>
          </div>
          <div className="flex flex-col gap-2">
            <span className="font-semibold text-ink">Account</span>
            <Link to="/login" className="text-ink-2 hover:text-ink">
              Sign in
            </Link>
            <Link to="/signup" className="text-ink-2 hover:text-ink">
              Create account
            </Link>
          </div>
        </nav>
      </div>
      <div className="shell border-t border-line py-6 text-xs text-ink-3">
        &copy; {new Date().getFullYear()} Studio.
        {taxed && taxed.taxName !== null && <> Prices exclude {taxed.taxName}.</>}
      </div>
    </footer>
  );
}

/** Website pages: header, content, footer. */
export function SitePage({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The signed-in shell.

const APP_LINKS = [
  { to: '/app', label: 'Reels', icon: Clapperboard, end: true },
  { to: '/app/insights', label: 'Insights', icon: BarChart3, end: false },
  { to: '/app/ideas', label: 'Ideas', icon: Lightbulb, end: false },
  { to: '/app/connections', label: 'Connections', icon: Link2, end: false },
  { to: '/app/billing', label: 'Plan & billing', icon: CreditCard, end: false },
] as const;

function initials(name: string | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'S';
}

function SideNav({ onNavigate }: { onNavigate?: () => void }) {
  const { account, logOut } = useAuth();
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center px-4">
        <Link to="/app" aria-label="Studio, your reels" className="rounded-md" onClick={onNavigate}>
          <Logo />
        </Link>
      </div>
      <div className="px-3 pt-1">
        <Link to="/app/new" tabIndex={-1} onClick={onNavigate}>
          <Button variant="primary" size="sm" full>
            <Plus aria-hidden="true" className="h-4 w-4" />
            New reel
          </Button>
        </Link>
      </div>
      <nav className="mt-4 flex flex-col gap-0.5 px-2" aria-label="Studio">
        {APP_LINKS.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            end={l.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cx(
                'flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium transition-colors',
                isActive ? 'bg-panel-3 text-ink' : 'text-ink-2 hover:bg-panel-2 hover:text-ink',
              )
            }
          >
            <l.icon aria-hidden="true" className="h-4 w-4 shrink-0" />
            {l.label}
          </NavLink>
        ))}
      </nav>
      <div className="mt-auto border-t border-line p-3">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-panel-3 text-xs font-semibold text-ink"
          >
            {initials(account?.name)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-ink">{account?.name}</span>
            <span className="block truncate text-xs text-ink-3">{account?.email}</span>
          </span>
          <button
            type="button"
            onClick={() => void logOut()}
            aria-label="Sign out"
            title="Sign out"
            className="flex h-8 w-8 items-center justify-center rounded-md text-ink-3 hover:bg-panel-2 hover:text-ink"
          >
            <LogOut aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Every signed-in screen except the editor: a sidebar, a page heading and
 * the page. The editor is a full-window workspace with its own top bar.
 */
export function AppShell({
  children,
  title,
  actions,
}: {
  children: ReactNode;
  title: ReactNode;
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname, location.search]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r border-line bg-panel lg:block">
        <SideNav />
      </aside>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-black/60"
            onClick={() => setOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r border-line bg-panel shadow-float">
            <SideNav onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-line bg-ground/90 px-4 backdrop-blur sm:px-6 lg:px-8">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
            className="-ml-1 flex h-9 w-9 items-center justify-center rounded-md text-ink hover:bg-panel-2 lg:hidden"
          >
            <Menu aria-hidden="true" className="h-5 w-5" />
          </button>
          <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-ink">{title}</h1>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
        <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
