import type { FrameSpec } from '../../../studio/src/lib/compose.js';

/**
 * A frame with an overlay clip cut in: the main picture, then the overlay
 * covering it, then the main frame's text on top of both -- so captions
 * keep reading straight through a B-roll cutaway, the way they do in every
 * talking-head reel.
 */
export function withOverlay(base: FrameSpec, overlay: FrameSpec): FrameSpec {
  return {
    ...base,
    layers: [
      ...base.layers.filter((l) => l.kind !== 'text'),
      ...overlay.layers.filter((l) => l.kind !== 'text'),
      ...base.layers.filter((l) => l.kind === 'text'),
    ],
  };
}
