import { SitePage } from '../components/chrome';
import { Hero } from './landing/Hero';
import { Workflow } from './landing/Workflow';
import { Captions } from './landing/Captions';
import { Dubbing } from './landing/Dubbing';
import { Insights } from './landing/Insights';
import { Plans } from './landing/Plans';
import { Faq } from './landing/Faq';
import { Cta } from './landing/Cta';
import { MotionProvider } from './landing/motion';

/**
 * The landing page: what it does, the product, then the price.
 *
 * Everything shown as available is available today. Dubbing and the
 * insights loop are designed and on the page because they shape the
 * decision, and each carries a Coming soon mark until it is switched on.
 * There are no testimonials or customer logos because there are no
 * customers yet, and the page simply does not have those sections.
 *
 * Motion has one authored moment -- the hero's reel over its timeline --
 * and otherwise moves the way a timeline does: a playhead in the header
 * ruler, an editor that settles flat, a picture that follows the steps.
 * Nothing starts hidden; see `landing/motion.tsx`.
 *
 * `#features`, `#captions`, `#dubbing` and `#faq` are linked from the
 * header and footer in `components/chrome.tsx`, so those ids are a
 * contract and must not be renamed here alone. The only `<h1>` lives in
 * `Hero`; every band contributes an `<h2>` that its `<section>` is
 * labelled by.
 */
export default function Landing() {
  return (
    <MotionProvider>
      <SitePage>
        <Hero />
        <Workflow />
        <Captions />
        <Dubbing />
        <Insights />
        <Plans />
        <Faq />
        <Cta />
      </SitePage>
    </MotionProvider>
  );
}
