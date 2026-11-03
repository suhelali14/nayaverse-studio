import { REEL_FRAMES } from './frames';
import { CtaLink, FromPrice } from './parts';

/**
 * The close: one sentence, one action, the price under it, and the sample
 * reel running past underneath like film through a gate. The strip is
 * decoration over real frames, so it is hidden from assistive technology,
 * pauses under a pointer, and stands still for reduced motion.
 */
export function Cta() {
  // Scenes 3 and 4 share their b-roll, so the strip runs them apart. Four
  // passes of five, so the -50% loop point is seamless at any width.
  const [r1, r2, r3, r4, r5] = REEL_FRAMES;
  const pass = [r1, r4, r2, r5, r3];
  const strip = [...pass, ...pass, ...pass, ...pass];
  return (
    <section aria-labelledby="cta-title" className="overflow-hidden bg-ink">
      <div className="shell pb-14 pt-24 text-center sm:pt-32">
        <h2 id="cta-title" className="display-hero mx-auto max-w-4xl text-ground">
          Make your next reel from a script.
        </h2>
        <div className="mt-10 flex justify-center">
          <CtaLink to="/signup" variant="primary">
            Get started
          </CtaLink>
        </div>
        <FromPrice>
          {(price, tax) => (
            <p className="tabular mt-4 text-sm text-ground/60">
              From {price} a month{tax ? `, plus ${tax}` : ''}
            </p>
          )}
        </FromPrice>
      </div>
      <div aria-hidden="true" className="pb-20 [mask-image:linear-gradient(to_right,transparent,black_12%,black_88%,transparent)]">
        <div className="marquee flex w-max gap-4">
          {strip.map((src, i) => (
            <img
              key={i}
              src={src}
              alt=""
              width={720}
              height={1280}
              loading="lazy"
              className="block h-56 w-auto rounded-lg sm:h-72"
            />
          ))}
        </div>
      </div>
    </section>
  );
}
