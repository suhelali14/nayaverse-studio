import { LazyMotion } from 'motion/react';
import type { ReactNode } from 'react';

/**
 * Motion for the website, loaded on demand.
 *
 * `m` components carry no animation features of their own; `LazyMotion`
 * fetches the DOM set after the page is up, so the landing chunk does not
 * grow by the full library for an effect. `strict` turns a stray
 * `motion.div` -- which would pull every feature back in -- into an error.
 *
 * One rule governs every use on these pages: nothing starts hidden. The
 * moving parts are scroll-linked transforms on content that is already on
 * screen, and a state change between two visible pictures. No section
 * fades in, so a crawler, a print, a full-page capture or a slow phone
 * never meets an invisible page.
 */
const features = () => import('./motion-features').then((mod) => mod.default);

export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={features} strict>
      {children}
    </LazyMotion>
  );
}

/** Exponential ease-out: quick to move, slow to settle, never a bounce. */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;
