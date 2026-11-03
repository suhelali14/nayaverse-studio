import { Pause, Play } from 'lucide-react';
import { useMotionValueEvent, useReducedMotion, useScroll } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { cx } from '../../components/ui';
import { REEL_FRAMES as FRAMES, REEL_SECONDS as SECONDS } from './frames';
import type { ReelScene } from './reel-scene';

/**
 * The hero picture: the sample reel standing over its timeline.
 *
 * The 3D scene is an enhancement on top of a picture that already works.
 * The HTML underneath -- the same five frames over the same four tracks,
 * stopped on Scene 2 -- is what a phone on a slow connection, a browser
 * without WebGL, a visitor saving data and a crawler all get, and it is
 * what everyone sees for the moment before the scene is drawn. three.js
 * is fetched only after the page is idle, so it never delays the headline.
 *
 * Motion that runs past five seconds gets a pause control (WCAG 2.2.2), and
 * someone whose system asks for less motion gets the still scene.
 */

const TOTAL = SECONDS.reduce((a, b) => a + b, 0);
const STILL_SCENE = 2;

function canUseWebGL(): boolean {
  try {
    const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
    if (nav.connection?.saveData) return false;
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2'));
  } catch {
    return false;
  }
}

export function ReelStage({ className }: { className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<ReelScene | null>(null);
  const still = useReducedMotion() ?? false;
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [webgl, setWebgl] = useState(true);

  useEffect(() => {
    if (!canUseWebGL()) {
      setWebgl(false);
      return;
    }
    let cancelled = false;
    const start = () => {
      void import('./reel-scene')
        .then(({ createReelScene }) => {
          if (cancelled || !host.current) return;
          scene.current = createReelScene(host.current, {
            frames: FRAMES,
            playing: !still,
            still,
            onReady: () => !cancelled && setReady(true),
          });
        })
        .catch(() => setWebgl(false));
    };
    // Safari has no requestIdleCallback; a short timeout stands in.
    const hasIdle = 'requestIdleCallback' in window;
    const handle = hasIdle ? window.requestIdleCallback(start, { timeout: 1200 }) : window.setTimeout(start, 300);
    return () => {
      cancelled = true;
      if (hasIdle) window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
      scene.current?.dispose();
      scene.current = null;
    };
  }, [still]);

  // Draw only while on screen.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => scene.current?.setVisible(Boolean(entry?.isIntersecting)), {
      rootMargin: '80px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ready]);

  useEffect(() => scene.current?.setPlaying(playing && !still), [playing, still, ready]);

  // As the hero scrolls away, the camera settles lower over the timeline.
  const { scrollYProgress } = useScroll({ target: box, offset: ['start start', 'end start'] });
  useMotionValueEvent(scrollYProgress, 'change', (v) => scene.current?.setScroll(v));

  return (
    <div className={cx('relative', className)}>
      <div
        ref={box}
        role="img"
        aria-label="Five frames of a sample reel standing over its timeline. A red playhead crosses the clips, and each scene's frame comes forward while it plays."
        className="relative h-full w-full"
      >
        <StillPicture hidden={ready} />
        <div
          ref={host}
          className={cx('absolute inset-0 transition-opacity duration-700', ready ? 'opacity-100' : 'opacity-0')}
        />
      </div>
      {webgl && !still && (
        <button
          type="button"
          onClick={() => setPlaying((p) => !p)}
          aria-pressed={!playing}
          aria-label={playing ? 'Pause the animation' : 'Play the animation'}
          className="absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center rounded-full border border-line-strong bg-ground/80 text-ink-2 backdrop-blur transition-colors hover:text-ink"
        >
          {playing ? <Pause aria-hidden="true" className="h-3.5 w-3.5" /> : <Play aria-hidden="true" className="h-3.5 w-3.5" />}
        </button>
      )}
    </div>
  );
}

/** The same picture in HTML: frames over tracks, stopped on Scene 2. */
function StillPicture({ hidden }: { hidden: boolean }) {
  const playhead = (SECONDS.slice(0, STILL_SCENE).reduce((a, b) => a + b, 0) + SECONDS[STILL_SCENE] * 0.45) / TOTAL;
  return (
    <div
      aria-hidden="true"
      className={cx(
        'absolute inset-0 flex flex-col justify-center gap-[4%] px-[6%] transition-opacity duration-700',
        hidden && 'opacity-0',
      )}
    >
      <div className="flex items-end gap-[1.6%]">
        {FRAMES.map((src, i) => (
          <img
            key={src}
            src={src}
            alt=""
            width={720}
            height={1280}
            className={cx(
              'aspect-[9/16] min-w-0 flex-1 rounded-lg object-cover shadow-frame transition-transform',
              i === STILL_SCENE ? '-translate-y-[6%] scale-[1.06]' : 'brightness-[0.7]',
            )}
          />
        ))}
      </div>
      <div className="relative space-y-1.5">
        <div className="flex h-3 gap-[3px]">
          <span className="rounded-sm" style={{ flex: 6.1 / TOTAL }} />
          <span className="rounded-sm bg-kind-asset" style={{ flex: 3 / TOTAL }} />
          <span style={{ flex: (TOTAL - 9.1) / TOTAL }} />
        </div>
        <div className="flex h-5 gap-[3px]">
          {SECONDS.map((s, i) => (
            <span key={i} className="rounded-sm bg-kind-photo" style={{ flex: s }} />
          ))}
        </div>
        <div className="flex h-2 gap-[3px]">
          {SECONDS.flatMap((s, i) => [
            <span key={`a${i}`} className="rounded-sm bg-cue" style={{ flex: s / 2 }} />,
            <span key={`b${i}`} className="rounded-sm bg-cue" style={{ flex: s / 2 }} />,
          ])}
        </div>
        <div className="h-3 rounded-sm bg-cue/80" />
        <span className="absolute -bottom-1 -top-2 w-0.5 rounded-full bg-accent" style={{ left: `${playhead * 100}%` }} />
      </div>
    </div>
  );
}
