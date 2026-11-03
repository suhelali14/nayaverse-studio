import { Check } from 'lucide-react';
import { m, useInView, useReducedMotion, useScroll, useTransform } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import editorShot from '../../assets/product/editor.jpg';
import editorPro from '../../assets/product/editor-pro.jpg';
import exportShot from '../../assets/product/export.jpg';
import wizardShot from '../../assets/product/wizard.jpg';
import { cx } from '../../components/ui';
import { EASE_OUT } from './motion';
import { Head } from './parts';

/**
 * What Studio does, in the order a reel gets made.
 *
 * One picture of the real editor stays in view while the steps scroll past
 * it, and moves to the part of the editor each step is about -- the scene
 * list, the timeline, the Look panel -- the way a person's eye would. The
 * first step shows the new-reel wizard and the last the export choices,
 * both real captures. Every claim is something the shipped editor does.
 *
 * `#features` is linked from the header and footer; keep the id.
 */

type View =
  | { kind: 'wizard' }
  | { kind: 'focus'; x: number; y: number; scale: number }
  | { kind: 'export' };

const STEPS: { title: string; body: string; points: string[]; view: View }[] = [
  {
    title: 'Write it with AI, then steer it',
    body: 'Give Studio a topic and a length. Pick one of five opening lines or write your own, compare three versions of the script, and have any single scene rewritten on your instruction while the rest stays as it is.',
    points: ['Every version is checked for invented numbers and promises', 'Or paste your own script and split it exactly as written'],
    view: { kind: 'wizard' },
  },
  {
    title: 'Your clips, under the right lines',
    body: 'Import footage and photos named by what they show. Studio puts each one under the scene that mentions it and says which word it matched, so you can see the reasoning and change it.',
    points: ['Matches on file names you control', 'Text cards where nothing fits'],
    view: { kind: 'focus', x: 0, y: 0.04, scale: 2.05 },
  },
  {
    title: 'A multi-track timeline',
    body: 'B-roll cuts in on its own track over the main one, captions sit on theirs, and music runs underneath with its waveform drawn. Trim, split, snap, zoom, mark and undo.',
    points: ['J, K and L to shuttle, S to split, Space to play', 'A level for every sound, and a mute on every track'],
    view: { kind: 'focus', x: 0, y: 0.42, scale: 1.72 },
  },
  {
    title: 'Grade it, move it, pace it',
    body: 'Five looks to start from and four sliders to finish: exposure, contrast, saturation and warmth. Push in or pull out, play a clip at half to double speed, fade in and out, and size and place the captions.',
    points: ['The export carries exactly what the viewer shows', 'Every change can be undone'],
    view: { kind: 'focus', x: 0.56, y: 0.24, scale: 2.25 },
  },
  {
    title: 'Export up to 4K, with sound',
    body: 'Draft at 1080p for a quick review, High at 20 Mbps for Reels and Shorts, or Maximum at 4K and 50 Mbps. The reel is encoded on your own computer, so it never waits in an upload queue.',
    points: ['Maximum is offered where your browser can encode 4K', 'H.264 everywhere, HEVC where it is supported'],
    view: { kind: 'export' },
  },
];

export function Workflow() {
  return (
    <section id="features" aria-labelledby="features-title" className="bg-ground">
      <div className="shell pt-24 sm:pt-32">
        <Head
          id="features-title"
          title="Everything between a script and a reel."
          lede="Writing, cutting, grading and captioning in one workspace, laid out like the editors you already know."
        />
        <Showcase />
      </div>
      <Steps />
    </section>
  );
}

/** The whole editor, settling flat as it comes up the screen. */
function Showcase() {
  const ref = useRef<HTMLDivElement>(null);
  const still = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'start 0.25'] });
  const rotateX = useTransform(scrollYProgress, [0, 1], [still ? 0 : 16, 0]);
  const scale = useTransform(scrollYProgress, [0, 1], [still ? 1 : 0.93, 1]);
  return (
    <div ref={ref} className="mt-14 [perspective:1600px] sm:mt-16">
      <m.figure
        style={{ rotateX, scale, transformOrigin: '50% 100%' }}
        className="m-0 overflow-hidden rounded-xl border border-line-strong bg-monitor shadow-frame"
      >
        <img
          src={editorShot}
          alt="The Studio editor: a script split into scenes on the left, the reel playing in the centre with its caption, the selected clip's details on the right and the timeline along the bottom."
          width={2400}
          height={1500}
          className="block h-auto w-full"
        />
      </m.figure>
    </div>
  );
}

function Steps() {
  const [active, setActive] = useState(0);
  return (
    <div className="shell pb-24 pt-20 sm:pb-32 sm:pt-28">
      <div className="lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-16">
        {/* The stage, held in view on a desk while the steps scroll by. */}
        <div className="hidden lg:block">
          <div className="sticky top-[max(6rem,calc(50vh-15rem))]">
            <Stage view={STEPS[active]!.view} label={STEPS[active]!.title} />
          </div>
        </div>

        <ol className="relative space-y-16 lg:space-y-0">
          {/* The rail the steps hang from, with the playhead on the current one. */}
          <span aria-hidden="true" className="absolute bottom-0 left-0 top-0 hidden w-px bg-line lg:block" />
          {STEPS.map((step, i) => (
            <Step key={step.title} index={i} active={active === i} onActive={() => setActive(i)} step={step} />
          ))}
        </ol>
      </div>
    </div>
  );
}

function Step({
  step,
  index,
  active,
  onActive,
}: {
  step: (typeof STEPS)[number];
  index: number;
  active: boolean;
  onActive: () => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  // Current while it crosses the middle band of the screen.
  const inView = useInView(ref, { margin: '-45% 0px -45% 0px' });
  useEffect(() => {
    if (inView) onActive();
  }, [inView, onActive]);

  return (
    <li ref={ref} className="relative lg:flex lg:min-h-[78vh] lg:items-center lg:pl-10 lg:last:min-h-[56vh]">
      <span
        aria-hidden="true"
        className={cx(
          'absolute -left-[3px] top-1/2 hidden h-12 w-[7px] -translate-y-1/2 rounded-full transition-colors duration-300 lg:block',
          active ? 'bg-accent' : 'bg-transparent',
        )}
      />
      {/* One class per state: stacking lg:opacity-40 and lg:opacity-100
          left the current step dimmed, whichever the stylesheet put last. */}
      <div className={cx('transition-opacity duration-300', active ? 'lg:opacity-100' : 'lg:opacity-40')}>
        {/* On a phone each step carries its own picture. */}
        <div className="mb-6 lg:hidden">
          <Stage view={step.view} label={step.title} />
        </div>
        <h3 className="display text-2xl text-ink sm:text-[1.875rem] sm:leading-[2.25rem]">{step.title}</h3>
        <p className="mt-3 max-w-prose text-base leading-relaxed text-ink-2">{step.body}</p>
        <ul className="mt-5 space-y-2.5">
          {step.points.map((p) => (
            <li key={p} className="flex items-start gap-2.5 text-sm text-ink">
              <Check aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-accent" strokeWidth={2.5} />
              {p}
            </li>
          ))}
        </ul>
      </div>
      <span className="sr-only">Step {index + 1} of {STEPS.length}.</span>
    </li>
  );
}

/**
 * The picture for a step. The editor capture is one image moved and scaled
 * to the region the step is about; the wizard and the export choices are
 * their own captures, crossfaded in. Nothing here starts hidden: whichever
 * view is current is drawn at full strength from the first frame.
 */
function Stage({ view, label }: { view: View; label: string }) {
  const still = useReducedMotion();
  const transition = still ? { duration: 0 } : { duration: 0.9, ease: EASE_OUT };
  const focus = view.kind === 'focus' ? view : { x: 0, y: 0, scale: 1 };
  const s = focus.scale;
  // Clamped so the zoomed picture never shows an edge.
  const x = Math.min(focus.x, 1 - 1 / s);
  const y = Math.min(focus.y, 1 - 1 / s);

  return (
    <figure
      aria-label={label}
      className="relative m-0 aspect-[16/10] overflow-hidden rounded-xl border border-line-strong bg-monitor shadow-frame"
    >
      <m.img
        src={editorPro}
        alt="The Studio editor with the scene list, the viewer, the Look panel and four timeline tracks: overlay, video, captions and music."
        width={2880}
        height={1800}
        loading="lazy"
        className="absolute inset-0 h-full w-full max-w-none"
        style={{ transformOrigin: '0 0' }}
        initial={false}
        animate={{
          x: `${-s * x * 100}%`,
          y: `${-s * y * 100}%`,
          scale: s,
          opacity: view.kind === 'wizard' ? 0 : view.kind === 'export' ? 0.5 : 1,
        }}
        transition={transition}
      />
      <m.div
        className="absolute inset-0 flex items-start justify-center overflow-hidden bg-monitor px-[8%] pt-[5%]"
        initial={false}
        animate={{ opacity: view.kind === 'wizard' ? 1 : 0 }}
        transition={transition}
        aria-hidden={view.kind !== 'wizard'}
      >
        <img
          src={wizardShot}
          alt="The new-reel wizard on its Script step: three versions to choose between, and every scene with Shorter, More specific, Punchier and Simpler words, or a rewrite in your own words."
          width={1200}
          height={969}
          loading="lazy"
          className="block h-auto w-full"
        />
      </m.div>
      <m.img
        src={exportShot}
        alt="Export choices: Draft at 1080 by 1920 and 8 Mbps, High at 20 Mbps, and Maximum at 2160 by 3840 (4K) and 50 Mbps, with sound included."
        width={704}
        height={776}
        loading="lazy"
        className="absolute right-[3%] top-[6%] w-[34%] rounded-lg shadow-float"
        initial={false}
        animate={{ opacity: view.kind === 'export' ? 1 : 0, y: view.kind === 'export' ? 0 : -12 }}
        transition={transition}
        aria-hidden={view.kind !== 'export'}
      />
    </figure>
  );
}
