import { CheckCircle2, RefreshCw, ShieldCheck, Unplug } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AppShell } from '../components/chrome';
import { PlatformMark } from '../components/platform-mark';
import { Badge, Button, Skeleton, useToast } from '../components/ui';
import { errorText, formatWhen } from '../components/project-card';
import { api, type PlatformInfo } from '../lib/api';

/**
 * Connecting Instagram, YouTube and (outside India) TikTok, read-only.
 *
 * Connecting sends the browser to the platform's own sign-in, which comes
 * back to the API and then here with `?connected=` or `?error=`. The first
 * sync runs during that round trip, so the account arrives with its posts.
 */
export default function Connections() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [platforms, setPlatforms] = useState<PlatformInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPlatforms((await api.connections()).platforms);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Back from a platform's sign-in.
  useEffect(() => {
    const connected = params.get('connected');
    const failed = params.get('error');
    if (!connected && !failed) return;
    if (connected) toast(`${connected[0]!.toUpperCase()}${connected.slice(1)} connected.`);
    if (failed) toast(failed, 'bad');
    setParams(new URLSearchParams(), { replace: true });
  }, [params, setParams, toast]);

  const connect = async (p: PlatformInfo) => {
    try {
      const { url } = await api.startConnection(p.id);
      window.location.assign(url);
    } catch (e) {
      toast(errorText(e), 'bad');
    }
  };

  const sync = async (p: PlatformInfo) => {
    try {
      await api.syncConnection(p.id);
      toast(`${p.name} is up to date.`);
    } catch (e) {
      toast(errorText(e), 'bad');
    }
    await load();
  };

  const disconnect = async (p: PlatformInfo) => {
    try {
      await api.disconnect(p.id);
      toast(`${p.name} disconnected. Its posts were removed from Studio.`);
    } catch (e) {
      toast(errorText(e), 'bad');
    }
    await load();
  };

  const anyConnected = platforms?.some((p) => p.connection !== null) ?? false;

  return (
    <AppShell title="Connections">
      <div className="max-w-3xl space-y-6">
        <p className="text-sm leading-relaxed text-ink-2">
          Connect the accounts you post to. Studio reads your posts and their numbers to build{' '}
          <Link to="/app/insights" className="font-medium text-ink underline">
            Insights
          </Link>{' '}
          and{' '}
          <Link to="/app/ideas" className="font-medium text-ink underline">
            Ideas
          </Link>
          .
        </p>

        {error && (
          <div className="flex items-center justify-between gap-3 rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">
            {error}
            <Button size="xs" onClick={() => load()}>
              Retry
            </Button>
          </div>
        )}

        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel">
          {platforms === null &&
            [0, 1].map((i) => (
              <li key={i} className="flex items-center gap-4 p-5" aria-hidden="true">
                <Skeleton className="h-10 w-10 rounded-lg" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-48" />
                </div>
              </li>
            ))}
          {platforms?.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-4 p-5">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-panel-3 text-ink">
                <PlatformMark platform={p.id} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold text-ink">{p.name}</h2>
                  {p.connection && (
                    <Badge tone={p.connection.lastError ? 'bad' : 'good'}>
                      {p.connection.lastError ? 'Needs attention' : 'Connected'}
                    </Badge>
                  )}
                  {!p.configured && !p.connection && <Badge tone="warn">Coming soon</Badge>}
                </div>
                {p.connection ? (
                  <p className="mt-0.5 truncate text-xs text-ink-3">
                    {p.connection.handle}
                    {p.connection.followers !== null && ` · ${p.connection.followers.toLocaleString('en-IN')} followers`}
                    {` · ${p.connection.posts} posts`}
                    {p.connection.lastSyncedAt ? ` · synced ${formatWhen(p.connection.lastSyncedAt)}` : ' · not synced yet'}
                  </p>
                ) : (
                  <p className="mt-0.5 text-xs text-ink-3">
                    {p.id === 'instagram'
                      ? 'Business or creator accounts.'
                      : p.id === 'youtube'
                        ? 'Your channel, Shorts and videos.'
                        : 'Your public videos.'}
                  </p>
                )}
                {p.connection?.lastError && <p className="mt-1 text-xs text-bad">{p.connection.lastError}</p>}
              </div>
              <div className="flex gap-2">
                {p.connection ? (
                  <>
                    <Button size="sm" onClick={() => sync(p)}>
                      <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
                      Sync
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => disconnect(p)} aria-label={`Disconnect ${p.name}`}>
                      <Unplug aria-hidden="true" className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Disconnect</span>
                    </Button>
                  </>
                ) : p.configured ? (
                  <Button size="sm" variant="primary" onClick={() => connect(p)}>
                    Connect
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>

        <div className="flex gap-3 rounded-lg border border-line p-4 text-xs leading-relaxed text-ink-2">
          <ShieldCheck aria-hidden="true" className="h-4 w-4 shrink-0 text-good" />
          <p>
            Read-only. Studio can see your posts and their numbers; it cannot post, comment or message for you.
            Disconnecting deletes the access and every post Studio stored from that account.
          </p>
        </div>

        {anyConnected && (
          <Link to="/app/insights" className="inline-flex items-center gap-2 text-sm font-medium text-ink underline">
            <CheckCircle2 aria-hidden="true" className="h-4 w-4 text-good" />
            See your insights
          </Link>
        )}
      </div>
    </AppShell>
  );
}
