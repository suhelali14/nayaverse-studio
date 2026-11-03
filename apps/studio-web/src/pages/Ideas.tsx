import { Clapperboard, Copy, Lightbulb } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AppShell } from '../components/chrome';
import { Badge, Button, Empty, Field, Input, Select, Skeleton, useToast } from '../components/ui';
import { errorText } from '../components/project-card';
import { api, type IdeasResult, type PlatformInfo } from '../lib/api';
import { useCatalogue } from '../lib/catalogue';
import { scriptKey } from '../lib/handoff';

/**
 * What to make next. Ideas come from the creator's own report -- through
 * the model when the server has one, from the rules otherwise -- and each
 * says which of their numbers it builds on. "Make this reel" opens a new
 * reel with the script already in the Script panel.
 */


const NICHE_KEY = 'studio.ideas.niche';

export default function Ideas() {
  const toast = useToast();
  const navigate = useNavigate();
  const { catalogue } = useCatalogue();
  const [platforms, setPlatforms] = useState<PlatformInfo[] | null>(null);
  const [niche, setNiche] = useState(() => {
    try {
      return localStorage.getItem(NICHE_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [audience, setAudience] = useState('');
  const [language, setLanguage] = useState('en');
  const [result, setResult] = useState<IdeasResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.connections().then((r) => setPlatforms(r.platforms), () => setPlatforms([]));
  }, []);

  const connected = platforms?.filter((p) => p.connection) ?? [];

  const generate = async () => {
    setLoading(true);
    setError(null);
    try {
      localStorage.setItem(NICHE_KEY, niche);
    } catch {
      /* a remembered niche is a convenience */
    }
    try {
      setResult(await api.ideas({ niche, language, ...(audience.trim() ? { audience: audience.trim() } : {}) }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  };

  const makeReel = async (title: string, script: string) => {
    try {
      const project = await api.createProject({ title: title.slice(0, 120), language });
      try {
        sessionStorage.setItem(scriptKey(project.id), script);
      } catch {
        /* the script is also copyable from this page */
      }
      navigate('/app/p/' + project.id);
    } catch (e) {
      toast(errorText(e), 'bad');
    }
  };

  return (
    <AppShell title="Ideas">
      <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)] lg:items-start">
        <section className="space-y-2 rounded-lg border border-line bg-panel p-5 lg:sticky lg:top-20" aria-label="What to base ideas on">
          <Field label="Your niche" htmlFor="niche" hint="What you post about, in a few words.">
            <Input id="niche" value={niche} maxLength={200} placeholder="Mumbai food and city life" onChange={(e) => setNiche(e.target.value)} />
          </Field>
          <Field label="Audience" htmlFor="audience" hint="Optional.">
            <Input id="audience" value={audience} maxLength={200} placeholder="College students in Pune" onChange={(e) => setAudience(e.target.value)} />
          </Field>
          <Field label="Language" htmlFor="idea-lang">
            <Select id="idea-lang" value={language} onChange={(e) => setLanguage(e.target.value)}>
              {(catalogue?.languages ?? []).map((l) => (
                <option key={l.code} value={l.code}>
                  {l.native === l.english ? l.english : `${l.native} · ${l.english}`}
                </option>
              ))}
            </Select>
          </Field>
          <Button variant="primary" full busy={loading} onClick={generate}>
            Get ideas
          </Button>
          <p className="mt-3 text-xs text-ink-3">
            {connected.length > 0
              ? `Built from ${connected.map((p) => p.name).join(' and ')} posts.`
              : (
                <>
                  No accounts connected, so ideas use your niche alone.{' '}
                  <Link to="/app/connections" className="font-medium text-ink-2 underline">
                    Connect one
                  </Link>{' '}
                  for ideas from your numbers.
                </>
              )}
          </p>
        </section>

        <section aria-live="polite" aria-label="Ideas">
          {error && <p className="mb-4 rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">{error}</p>}
          {loading && (
            <div className="space-y-3" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-36 w-full rounded-lg" label="Thinking of ideas" />
              ))}
            </div>
          )}
          {!loading && result === null && (
            <Empty
              icon={<Lightbulb aria-hidden="true" className="h-5 w-5" />}
              title="Your next reels, from your own numbers"
              body="Tell Studio your niche and get ideas with a hook and a ready script. Each one says which of your posts it builds on."
            />
          )}
          {!loading && result && (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-ink-3">
                <Badge tone={result.source === 'model' ? 'accent' : 'neutral'}>
                  {result.source === 'model' ? 'Written for you' : 'From your numbers'}
                </Badge>
                {result.note ?? (result.source === 'model' ? `Written by ${result.model} from your report.` : 'Built from the patterns in your posts.')}
              </div>
              <ol className="space-y-3">
                {result.ideas.map((idea, i) => (
                  <li key={i} className="rounded-lg border border-line bg-panel p-5">
                    <h3 className="text-base font-semibold text-ink">{idea.title}</h3>
                    <p className="mt-2 text-sm text-ink">
                      <span className="font-medium text-ink-3">Hook · </span>
                      {idea.hook}
                    </p>
                    <p className="mt-1 text-sm text-ink-2">{idea.angle}</p>
                    <p className="mt-2 text-xs text-good">{idea.why}</p>
                    <details className="group mt-3">
                      <summary className="cursor-pointer list-none text-xs font-medium text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
                        <span className="group-open:hidden">Show script</span>
                        <span className="hidden group-open:inline">Hide script</span>
                      </summary>
                      <p className="mt-2 whitespace-pre-line rounded-md bg-panel-2 p-3 text-sm leading-relaxed text-ink">{idea.script}</p>
                    </details>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button size="sm" onClick={() => makeReel(idea.title, idea.script)}>
                        <Clapperboard aria-hidden="true" className="h-4 w-4" />
                        Make this reel
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(idea.script);
                            toast('Script copied.');
                          } catch {
                            toast('Copying is blocked in this browser.', 'bad');
                          }
                        }}
                      >
                        <Copy aria-hidden="true" className="h-4 w-4" />
                        Copy script
                      </Button>
                    </div>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      </div>
    </AppShell>
  );
}
