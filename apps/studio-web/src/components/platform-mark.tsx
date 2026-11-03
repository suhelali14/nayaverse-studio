import type { SocialPlatform } from '../lib/api';
import { cx } from './ui';

/**
 * A plain outline glyph per platform: a camera square, a play box, a note.
 * Enough to tell the three apart at a glance, in the app's own stroke and
 * colour, without reproducing anyone's trademark artwork.
 */
export function PlatformMark({ platform, className }: { platform: SocialPlatform; className?: string }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className: cx('h-5 w-5 shrink-0', className),
  };
  if (platform === 'instagram') {
    return (
      <svg {...common}>
        <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
        <circle cx="12" cy="12" r="4" />
        <circle cx="17.2" cy="6.8" r="0.6" fill="currentColor" />
      </svg>
    );
  }
  if (platform === 'youtube') {
    return (
      <svg {...common}>
        <rect x="2.5" y="5.5" width="19" height="13" rx="4" />
        <path d="M10.5 9.5v5l4.2-2.5z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M14 4v10.5a3.5 3.5 0 1 1-3.5-3.5" />
      <path d="M14 4c.6 2.4 2.3 3.9 5 4.2" />
    </svg>
  );
}
