import frameEn from '../../assets/product/frame-en.jpg';
import frameHi from '../../assets/product/frame-hi.jpg';
import frameTa from '../../assets/product/frame-ta.jpg';
import { WithCatalogue } from '../../lib/catalogue';
import { Band, Head } from './parts';

/**
 * Captions, shown as the reel shows them.
 *
 * The three frames were rendered by Studio's own compositor from the same
 * sample cut, one script per language, so the type, the outline and the
 * placement are exactly what an export carries. Which languages are Indian
 * is a field on each catalogue entry, so the list below is the product's
 * own and grows by itself.
 */

const FRAMES = [
  { src: frameEn, label: 'English', lang: 'en' },
  { src: frameHi, label: 'हिन्दी', lang: 'hi' },
  { src: frameTa, label: 'தமிழ்', lang: 'ta' },
] as const;

export function Captions() {
  return (
    <Band id="captions" labelledBy="captions-title" tone="muted">
      <div className="grid items-center gap-14 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="min-w-0">
          <Head
            id="captions-title"
            title="Captions in the language your audience speaks."
            lede="Each word appears as it is read and is drawn into the picture in its own script. Names, brands and mixed-language lines come out exactly as you wrote them."
          />
          <WithCatalogue fallback={<div className="mt-8 h-24" />}>
            {(c) => {
              const indian = c.languages.filter((l) => l.indian);
              return (
                <div className="mt-8">
                  <p className="text-sm font-semibold text-ink">
                    {indian.length} Indian languages, plus English and {c.languages.length - indian.length - 1} more
                  </p>
                  <ul className="mt-3 flex flex-wrap gap-1.5">
                    {indian.map((l) => (
                      <li
                        key={l.code}
                        lang={l.code}
                        title={l.english}
                        className="rounded-md border border-line-strong bg-panel px-2.5 py-1 text-sm text-ink"
                      >
                        {l.native}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            }}
          </WithCatalogue>
        </div>

        <ul className="grid grid-cols-3 gap-3 sm:gap-5" aria-label="The same scene captioned in three languages">
          {FRAMES.map((f, i) => (
            <li key={f.lang} className={i === 1 ? 'sm:-translate-y-6' : undefined}>
              <img
                src={f.src}
                alt={`A frame of the sample reel captioned in ${f.label}`}
                width={540}
                height={960}
                loading="lazy"
                className="block aspect-[9/16] w-full rounded-xl border border-line-strong object-cover shadow-frame"
              />
              <p lang={f.lang} className="mt-3 text-center text-sm text-ink-2">
                {f.label}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </Band>
  );
}
