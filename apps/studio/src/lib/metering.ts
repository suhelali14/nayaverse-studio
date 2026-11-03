/**
 * How a dub is counted, as a rule with no prices in it.
 *
 * One minute of finished video in one language is one billed minute,
 * rounded up, and nothing is billed as less than one -- a ten-second dub
 * costs the provider a request like any other.
 *
 * This lives apart from `dubbing.ts` for one reason: the web editor needs
 * the count to show a quote, and importing `dubbing.ts` for it pulled the
 * whole catalogue into the browser bundle -- plan lines and the dub rate --
 * when the editor reads those from `GET /api/catalogue`. A rule with no
 * data in it can be imported anywhere.
 */
export function billedMinutes(seconds: number): number {
  return Math.max(1, Math.ceil(Math.max(0, seconds) / 60));
}
