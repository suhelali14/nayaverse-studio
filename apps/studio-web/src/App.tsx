import { lazy, Suspense, useLayoutEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Spinner, ToastHost } from './components/ui';
import { ContextMenuProvider } from './components/ContextMenu';
import { AuthProvider, useAuth } from './lib/auth';
import { CatalogueProvider } from './lib/catalogue';

/**
 * The route table, which is also the product's shape:
 *
 *   /                 landing -- everything a stranger needs to decide
 *   /pricing          the plans, in their own page so it can be linked
 *   /signup /login    get an account
 *   /choose-plan      pick one. The dashboard is locked until this is done.
 *   /app              dashboard
 *   /app/new          a new reel, written with AI and steered step by step
 *   /app/p/:id        the editor
 *   /app/billing      plan, usage and payments
 *   /app/connections  Instagram, YouTube, TikTok
 *   /app/insights     what the creator's posts say
 *   /app/ideas        what to make next
 *
 * The editor is lazily loaded. It pulls in the demuxer and the whole
 * WebCodecs pipeline, and a visitor reading the landing page should not
 * download a video editor to do it.
 */

const Landing = lazy(() => import('./pages/Landing'));
const Pricing = lazy(() => import('./pages/Pricing'));
const SignUp = lazy(() => import('./pages/SignUp'));
const LogIn = lazy(() => import('./pages/LogIn'));
const ChoosePlan = lazy(() => import('./pages/ChoosePlan'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Billing = lazy(() => import('./pages/Billing'));
const ProjectEditor = lazy(() => import('./pages/ProjectEditor'));
const Connections = lazy(() => import('./pages/Connections'));
const Insights = lazy(() => import('./pages/Insights'));
const Ideas = lazy(() => import('./pages/Ideas'));
const NewReel = lazy(() => import('./pages/NewReel'));

function Loading() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center text-ink-3">
      <Spinner className="h-6 w-6" />
    </div>
  );
}

/**
 * The website is light and the app is dark (see index.css). Set on <html>
 * before paint, so moving between the two never flashes the wrong ground.
 */
function RouteTheme() {
  const { pathname } = useLocation();
  useLayoutEffect(() => {
    const dark = pathname === '/app' || pathname.startsWith('/app/');
    if (dark) document.documentElement.dataset.theme = 'dark';
    else delete document.documentElement.dataset.theme;
  }, [pathname]);
  return null;
}

/**
 * A gate that waits rather than guessing.
 *
 * While the stored token is being checked it renders nothing but a spinner.
 * Redirecting on `!account` would bounce every reload through the landing
 * page first, which looks like being signed out.
 */
function RequireAccount({ children, needsPlan = true }: { children: ReactNode; needsPlan?: boolean }) {
  const { status, account } = useAuth();
  const location = useLocation();

  if (status === 'checking') return <Loading />;
  if (status === 'anonymous' || !account) {
    // Where they were going, so signing in can finish the journey.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (needsPlan && account.planId === null) return <Navigate to="/choose-plan" replace />;
  return <>{children}</>;
}

/** Signed-in visitors have no use for the sign-up form. */
function AnonymousOnly({ children }: { children: ReactNode }) {
  const { status, account } = useAuth();
  if (status === 'checking') return <Loading />;
  if (status === 'signed-in' && account) {
    return <Navigate to={account.planId ? '/app' : '/choose-plan'} replace />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
      <RouteTheme />
      <AuthProvider>
        <CatalogueProvider>
        <ToastHost>
        <ContextMenuProvider>
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/pricing" element={<Pricing />} />

              <Route
                path="/signup"
                element={
                  <AnonymousOnly>
                    <SignUp />
                  </AnonymousOnly>
                }
              />
              <Route
                path="/login"
                element={
                  <AnonymousOnly>
                    <LogIn />
                  </AnonymousOnly>
                }
              />

              <Route
                path="/choose-plan"
                element={
                  <RequireAccount needsPlan={false}>
                    <ChoosePlan />
                  </RequireAccount>
                }
              />
              <Route
                path="/app"
                element={
                  <RequireAccount>
                    <Dashboard />
                  </RequireAccount>
                }
              />
              <Route
                path="/app/new"
                element={
                  <RequireAccount>
                    <NewReel />
                  </RequireAccount>
                }
              />
              <Route
                path="/app/p/:id"
                element={
                  <RequireAccount>
                    <ProjectEditor />
                  </RequireAccount>
                }
              />
              <Route
                path="/app/connections"
                element={
                  <RequireAccount>
                    <Connections />
                  </RequireAccount>
                }
              />
              <Route
                path="/app/insights"
                element={
                  <RequireAccount>
                    <Insights />
                  </RequireAccount>
                }
              />
              <Route
                path="/app/ideas"
                element={
                  <RequireAccount>
                    <Ideas />
                  </RequireAccount>
                }
              />
              <Route
                path="/app/billing"
                element={
                  <RequireAccount>
                    <Billing />
                  </RequireAccount>
                }
              />

              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </ContextMenuProvider>
        </ToastHost>
        </CatalogueProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
