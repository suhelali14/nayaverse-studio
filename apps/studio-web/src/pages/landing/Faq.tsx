import { Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { Band, Head } from './parts';

/**
 * The objections, answered.
 *
 * Native `<details>` rather than a hand-rolled accordion: it is keyboard
 * operable, it is announced as expandable, it works before JavaScript loads,
 * and the browser's own open state cannot get out of step with ours. There is
 * no version of this component worth writing.
 *
 * The questions are the ones that decide a subscription -- phone, browser,
 * audio, cancelling, privacy, bad scripts -- and each answer says the
 * inconvenient half out loud, because the alternative is a refund request on
 * day two.
 */

interface Item {
  readonly q: string;
  readonly a: ReactNode;
}

const ITEMS: readonly Item[] = [
  {
    q: 'Does it work on my phone?',
    a: (
      <>
        Filming is your phone&apos;s job, and uploading from it is fine. The frame-exact editor is
        built for a desktop or laptop browser, though: the video APIs it needs are unevenly
        supported on mobile, so treat editing on a phone as unsupported for now rather than
        half-working. Reviewing the finished reel and posting it from your phone is normal.
      </>
    ),
  },
  {
    q: 'Which browsers can I use?',
    a: (
      <>
        Chrome or Edge is the safe answer. Safari can decode video from 16.4 onwards, but encoding
        audio only arrived in Safari 26, so an older Safari can review a cut and not export one.
        Studio checks your browser before an export starts and tells you if it cannot finish,
        instead of failing somewhere in the middle.
      </>
    ),
  },
  {
    q: 'What happens to my audio?',
    a: (
      <>
        Studio&rsquo;s engine keeps your audio and re-times it to a reordered cut, decoding,
        resampling and re-muxing every segment. The web editor does not hand its timeline to that
        render yet, so today its export is <strong className="text-ink">a silent draft</strong> for
        checking the cut &mdash; and it says so, because an export that quietly dropped your voice
        would be worse than one that admits it has none.
      </>
    ),
  },
  {
    q: 'Can I cancel?',
    a: (
      <>
        Yes, from the billing screen, without talking to anyone. The plan runs to the end of the
        period you have already paid for and then stops. Your reels and your timeline files are
        yours to download before you go.
      </>
    ),
  },
  {
    q: 'Is my footage private?',
    a: (
      <>
        Your upload goes to object storage so the render machine can read it, and it is used for
        your renders and nothing else. The straight part: there is no signed data-processing
        agreement to hand you yet, and no support response time to promise. If you are uploading a
        client&apos;s footage and need either of those on paper, ask before you upload rather than
        after.
      </>
    ),
  },
  {
    q: 'What if the generated script is bad?',
    a: (
      <>
        Rewrite it, or paste your own and skip the generation entirely &mdash; it is an editable
        text box and the cut is computed from whatever it finally says. Worth knowing: because
        nothing transcribes your footage yet, the shots are matched to the script in proportion. If
        you improvised instead of reading it, expect to drag a couple of edges in the editor.
      </>
    ),
  },
  {
    q: 'Do I need to install anything?',
    a: (
      <>
        No. No desktop app, no extension, no ffmpeg on your machine. The editor downloads in well
        under a megabyte and uses the codecs your browser already ships with.
      </>
    ),
  },
  {
    q: 'What is not available yet?',
    a: (
      <>
        Dubbing, transcribing speech from your footage, connecting Instagram, YouTube and TikTok for
        insights, and posting straight to them are on the way and marked Coming soon on this page.
        Until speech transcription is on, captions are paced from your script. Exporting from the
        browser makes a draft without audio. Generated-avatar reels are not built and not sold.
      </>
    ),
  },
];

export function Faq() {
  return (
    <Band id="faq" labelledBy="faq-title" tone="muted">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
        <Head id="faq-title" title="Questions" />

        <div className="divide-y divide-line border-y border-line">
          {ITEMS.map((item) => (
            <details key={item.q} className="group">
              {/* Padding, not a fixed height: the summary has to clear 44px for
                  a thumb even when the question wraps to two lines. */}
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-base font-medium text-ink [&::-webkit-details-marker]:hidden">
                {item.q}
                <Plus
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 text-ink-3 transition-transform duration-200 group-open:rotate-45"
                />
              </summary>
              <div className="max-w-prose pb-5 text-sm leading-relaxed text-ink-2">{item.a}</div>
            </details>
          ))}
        </div>
      </div>
    </Band>
  );
}
