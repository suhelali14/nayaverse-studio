import { CtaLink, FromPrice } from './parts';
import { ReelStage } from './ReelStage';

/**
 * The top of the page: what it does, in one sentence, and the product's
 * one idea in one picture -- lines on a timeline becoming frames of a reel.
 *
 * The picture is the sample reel from the product captures, drawn by
 * Studio's own compositor, standing over that cut's real timeline; the
 * line under it says so. Nothing on this band animates in: it is on
 * screen before anyone scrolls, and a headline that fades in is a delay.
 */
export function Hero() {
  return (
    <section aria-labelledby="hero-title" className="overflow-hidden">
      <div className="shell grid items-center gap-x-4 gap-y-10 pb-16 pt-12 sm:pt-16 lg:min-h-[calc(100svh-4rem)] lg:grid-cols-[minmax(0,11fr)_minmax(0,13fr)] lg:py-12">
        <div className="relative z-10">
          <h1 id="hero-title" className="display-hero text-ink">
            Turn a script into a finished reel.
          </h1>
          <p className="mt-6 max-w-[34rem] text-pretty text-lg leading-relaxed text-ink-2">
            Studio writes or splits your script into scenes, puts your clips under the lines they belong to and
            captions every word. Then you finish it on a multi-track timeline and export it, up to 4K, without
            leaving the browser.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <CtaLink to="/signup" variant="primary">
              Get started
            </CtaLink>
            <CtaLink to="/pricing">See pricing</CtaLink>
          </div>
          <FromPrice>
            {(price, tax) => (
              <p className="tabular mt-4 text-sm text-ink-3">
                Plans from {price} a month{tax ? `, plus ${tax}` : ''}
              </p>
            )}
          </FromPrice>
        </div>

        <figure className="m-0 min-w-0">
          <ReelStage className="aspect-[16/11] w-full" />
          <figcaption className="tabular mt-1 text-xs text-ink-3">
            The sample reel, 15.9 seconds in five scenes, as Studio cut and captioned it.
          </figcaption>
        </figure>
      </div>
    </section>
  );
}
