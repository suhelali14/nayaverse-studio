import { Badge, Panel } from '../../components/ui';
import { WithCatalogue, bothPrices, type Catalogue } from '../../lib/catalogue';
import { Band, Head } from './parts';

/**
 * Dubbing: the languages, which ones get lip-sync, and the price.
 *
 * Marked Coming soon because no dubbing provider is connected yet -- the
 * languages, metering and price are real, the voice is not. The list,
 * the lip-sync column and the rate all come from the served catalogue.
 */

export function Dubbing() {
  return (
    <WithCatalogue fallback={<div id="dubbing" className="h-[720px]" />}>
      {(c) => <DubbingBand c={c} />}
    </WithCatalogue>
  );
}

function DubbingBand({ c }: { c: Catalogue }) {
  const languages = c.languages;
  const synced = languages.filter((l) => l.lipSync).length;
  // The notes that are about dubbing. The rest are shown with the plans.
  const notes = c.notes.filter((note) => /dub/i.test(note));

  return (
    <Band id="dubbing" labelledBy="dubbing-title">
      <Head
        id="dubbing-title"
        soon
        title={`One reel, dubbed into ${languages.length} languages.`}
        lede={`Post the same reel to a new audience in their language. ${synced} languages also get lip movement matched to the new voice.`}
      />

      <div className="mt-12 grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)] lg:gap-14">
        <div className="min-w-0 overflow-hidden rounded-xl border border-line">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-panel-2">
              <tr className="text-left">
                <th scope="col" className="px-4 py-2.5 text-xs font-semibold text-ink-2">
                  Language
                </th>
                <th scope="col" className="px-4 py-2.5 text-xs font-semibold text-ink-2">
                  Dub
                </th>
              </tr>
            </thead>
            <tbody>
              {languages.map((lang) => (
                <tr key={lang.code} className="border-t border-line">
                  <th scope="row" className="px-4 py-2.5 text-left font-normal">
                    <span className="text-ink" lang={lang.code}>
                      {lang.native}
                    </span>
                    {/* The English name is repeated only when it differs, so
                        the column does not read "English English". */}
                    {lang.native !== lang.english && <span className="ml-2 text-ink-3">{lang.english}</span>}
                  </th>
                  <td className="px-4 py-2.5">
                    {lang.lipSync ? <Badge tone="good">Voice and lip-sync</Badge> : <Badge>Voice</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="min-w-0">
          <Panel className="p-6">
            <h3 className="text-sm font-semibold text-ink">Price</h3>
            <p className="tabular mt-2 text-2xl font-semibold text-ink">
              {bothPrices(c, c.metered.dubMinute)}
              <span className="ml-1.5 text-sm font-normal text-ink-3">per minute</span>
            </p>
            <p className="mt-4 text-sm text-ink-2">Included each month:</p>
            <ul className="mt-2 space-y-1.5 text-sm">
              {c.plans.map((plan) => (
                <li key={plan.id} className="flex justify-between gap-4">
                  <span className="text-ink-2">{plan.name}</span>
                  <span className="tabular text-ink">
                    {plan.dubMinutes === 0 ? '—' : `${plan.dubMinutes} min`}
                  </span>
                </li>
              ))}
            </ul>
            {notes.length > 0 && (
              <ul className="mt-5 space-y-2 border-t border-line pt-4 text-xs leading-relaxed text-ink-3">
                {notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </Band>
  );
}
