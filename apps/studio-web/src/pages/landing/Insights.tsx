import insightsShot from '../../assets/product/insights.jpg';
import { Band, Head, Shot } from './parts';

/**
 * The loop after posting: connect the accounts, read what worked, get the
 * next idea from it. Marked Coming soon until the platform apps behind the
 * connections are approved and switched on. The capture is the real
 * Insights screen on a sample account (see the provenance in the file).
 */

const POINTS = [
  ['Connect Instagram and YouTube', 'and TikTok outside India. Read-only: Studio never posts for you.'],
  ['See what works for you', 'topics, opening lines, lengths and days, each against your own usual.'],
  ['Get the next idea', 'with a hook and a script built from your best posts, ready to open in the editor.'],
] as const;

export function Insights() {
  return (
    <Band id="insights" labelledBy="insights-title" tone="muted">
      <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
        <div className="min-w-0">
          <Head
            id="insights-title"
            soon
            title="Know what to make next."
            lede="Your numbers and your ideas in the same place you make the reel."
          />
          <dl className="mt-8 space-y-4">
            {POINTS.map(([term, detail]) => (
              <div key={term} className="border-l border-line-strong pl-4">
                <dt className="text-sm font-semibold text-ink">{term}</dt>
                <dd className="mt-0.5 text-sm leading-relaxed text-ink-2">{detail}</dd>
              </div>
            ))}
          </dl>
        </div>
        <Shot
          src={insightsShot}
          width={1168}
          height={520}
          alt="The Insights screen: posts, median views, engagement and posting rate, views per week, and findings such as which topic and opening line work best."
          className="min-w-0"
        />
      </div>
    </Band>
  );
}
