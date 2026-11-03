import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, hasToken, setToken, type Account } from './api';

/**
 * Who is signed in, for the whole app.
 *
 * ── The one decision worth recording ─────────────────────────────────
 *
 * `status` has four values, not two. "Not signed in" and "we have not
 * checked yet" are different states, and collapsing them is what makes an
 * app flash its landing page for a moment on every reload before the
 * dashboard appears. A guard that waits for `checking` to finish shows
 * nothing instead of showing the wrong thing.
 *
 * This is **not** a security boundary. Every protected route still needs a
 * token the API validates; hiding a screen only keeps the UI honest.
 */

export type AuthStatus = 'checking' | 'anonymous' | 'signed-in';

interface AuthValue {
  readonly status: AuthStatus;
  readonly account: Account | null;
  signUp(input: {
    email: string;
    password: string;
    name: string;
    region: 'IN' | 'WORLD';
  }): Promise<Account>;
  logIn(input: { email: string; password: string }): Promise<Account>;
  logOut(): Promise<void>;
  /** After choosing a plan, so the dashboard unlocks without a reload. */
  refresh(): Promise<void>;
}

const Ctx = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const value = useContext(Ctx);
  if (!value) throw new Error('useAuth was called outside AuthProvider.');
  return value;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>(hasToken() ? 'checking' : 'anonymous');
  const [account, setAccount] = useState<Account | null>(null);

  useEffect(() => {
    if (!hasToken()) return;
    let alive = true;
    void api
      .me()
      .then((me) => {
        if (!alive) return;
        setAccount(me);
        setStatus('signed-in');
      })
      .catch(() => {
        // A stored token the server rejects is the same as no token. The
        // client already cleared it on the 401.
        if (!alive) return;
        setToken(null);
        setAccount(null);
        setStatus('anonymous');
      });
    return () => void (alive = false);
  }, []);

  const adopt = useCallback((result: { token: string; account: Account }) => {
    setToken(result.token);
    setAccount(result.account);
    setStatus('signed-in');
    return result.account;
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      account,
      signUp: (input) => api.signUp(input).then(adopt),
      logIn: (input) => api.logIn(input).then(adopt),
      logOut: async () => {
        await api.logOut();
        setAccount(null);
        setStatus('anonymous');
      },
      refresh: async () => {
        const me = await api.me();
        setAccount(me);
      },
    }),
    [status, account, adopt],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
