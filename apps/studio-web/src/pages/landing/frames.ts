import reel1 from '../../assets/product/reel-1.jpg';
import reel2 from '../../assets/product/reel-2.jpg';
import reel3 from '../../assets/product/reel-3.jpg';
import reel4 from '../../assets/product/reel-4.jpg';
import reel5 from '../../assets/product/reel-5.jpg';

/**
 * The sample reel "Mumbai mornings", one frame per scene, as Studio's own
 * compositor drew them (site-captures.mjs, on drawn b-roll), and the
 * scene lengths of that cut in seconds. The hero and the close both use it.
 */
export const REEL_FRAMES = [reel1, reel2, reel3, reel4, reel5] as const;
export const REEL_SECONDS = [2.9, 2.9, 3.3, 3.6, 3.3] as const;
