import { Film, Wand2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Segmented, Select, Spinner, Textarea, cx, useToast } from '../components/ui';
import { ApiError, api, type VideoClip } from '../lib/api';
import type { Editor } from './useEditor';

/**
 * Make a clip with AI, for a line of the script.
 *
 * Choose the line, have the shot written (subject, setting, light, camera)
 * and change it if it is not what you see, optionally start from the frame
 * at the playhead so the clip continues your own footage, then make it. The
 * finished clip arrives in the media bin like anything imported, and can be
 * cut in over the line it was made for.
 *
 * The server meters seconds per plan and month and holds the provider's key;
 * this panel only ever asks it. Off servers without a provider say so in one
 * line and get out of the way.
 */

interface Made extends VideoClip {
  /** The scene it was made for, to offer cutting it in there. */
  readonly sceneId: string | null;
  /** Its name in the media bin, once downloaded. */
  readonly name?: string;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .split('-')
    .filter(Boolean)
    .slice(0, 3)
    .join('-') || 'clip';

export function Generate({
  ed,
  topic,
  frame,
  requestFor,
  onRequestTaken,
}: {
  ed: Editor;
  topic: string;
  /** The frame at the playhead, as a JPEG data URI, to start the clip from. */
  frame: () => string | null;
  /** A scene the right-click menu asked for a shot of. */
  requestFor: string | null;
  onRequestTaken: () => void;
}) {
  const toast = useToast();
  const [allowance, setAllowance] = useState<{ used: number; limit: number; configured: boolean } | null>(null);
  const [sceneId, setSceneId] = useState<string>('');
  const [prompt, setPrompt] = useState('');
  const [seconds, setSeconds] = useState<'5' | '10'>('5');
  const [fromFrame, setFromFrame] = useState(false);
  const [writing, setWriting] = useState(false);
  const [made, setMade] = useState<Made[]>([]);
  const [error, setError] = useState<string | null>(null);
  const edRef = useRef(ed);
  edRef.current = ed;

  const refresh = () => api.videoAllowance().then(setAllowance, () => undefined);
  useEffect(() => {
    void refresh();
  }, []);

  const scene = ed.clips.find((c) => c.id === sceneId) ?? null;
  const labelOf = (id: string) => {
    const i = ed.clips.findIndex((c) => c.id === id);
    return i === 0 ? 'Hook' : i === ed.clips.length - 1 && ed.clips.length > 2 ? 'Call to action' : `Scene ${i}`;
  };

  const writeShot = async (id = sceneId) => {
    const c = edRef.current.clips.find((x) => x.id === id);
    if (!c || !c.caption.trim()) return;
    setWriting(true);
    setError(null);
    try {
      const out = await api.shotPrompt({
        line: c.caption.trim(),
        visual: edRef.current.shotInfo(c.id)?.label ?? '',
        topic,
      });
      setPrompt(out.prompt);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The shot could not be written.');
    } finally {
      setWriting(false);
    }
  };

  // Asked from the right-click menu: choose that line and write its shot.
  useEffect(() => {
    if (!requestFor) return;
    setSceneId(requestFor);
    onRequestTaken();
    void writeShot(requestFor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestFor]);

  const make = async () => {
    setError(null);
    try {
      const image = fromFrame ? frame() : null;
      const clip = await api.startVideo({ prompt: prompt.trim(), seconds: Number(seconds), image });
      setMade((m) => [{ ...clip, sceneId: sceneId || null }, ...m]);
      void refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The clip could not be started.');
      void refresh();
    }
  };

  // While anything is being made, ask after it every few seconds; fetch it
  // into the media bin the moment it is ready.
  const running = made.some((m) => m.status === 'running');
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(async () => {
      for (const m of made.filter((x) => x.status === 'running')) {
        try {
          const next = await api.videoStatus(m.id);
          if (next.status === 'running') continue;
          let name: string | undefined;
          if (next.status === 'ready') {
            const blob = await api.videoFile(m.id);
            name = `ai-${slug(m.prompt)}-${m.id.slice(-4)}.mp4`;
            await edRef.current.actions.load([new File([blob], name, { type: 'video/mp4' })], false);
            toast('AI clip added to your media.');
          }
          setMade((all) => all.map((x) => (x.id === m.id ? { ...x, ...next, ...(name ? { name } : {}) } : x)));
        } catch {
          /* asked again on the next tick */
        }
      }
    }, 4000);
    return () => window.clearInterval(timer);
  }, [running, made, toast]);

  if (!allowance) return null;
  if (!allowance.configured) {
    return (
      <p className="flex items-center gap-2 border-b border-line px-3 py-2.5 text-xs text-ink-3">
        <Wand2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        Making clips with AI is not set up on this server yet.
        <Badge tone="warn">Coming soon</Badge>
      </p>
    );
  }
  if (allowance.limit === 0) {
    return (
      <p className="flex items-center gap-2 border-b border-line px-3 py-2.5 text-xs text-ink-3">
        <Wand2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        Clips made with AI are part of the larger plans.
      </p>
    );
  }

  const left = Math.max(0, allowance.limit - allowance.used);
  const need = Number(seconds);

  return (
    <section aria-labelledby="gen-title" className="space-y-3 border-b border-line p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 id="gen-title" className="flex items-center gap-1.5 text-xs font-semibold text-ink">
          <Wand2 aria-hidden="true" className="h-3.5 w-3.5 text-accent" />
          Make a clip with AI
        </h3>
        <span className="tabular text-2xs text-ink-3" title="AI video seconds left this month">
          {left} of {allowance.limit}s left
        </span>
      </div>

      <div className="flex gap-2">
        <Select compact aria-label="Line to make a shot for" value={sceneId} onChange={(e) => setSceneId(e.target.value)} className="min-w-0 flex-1">
          <option value="">Describe it yourself</option>
          {ed.clips.map((c) => (
            <option key={c.id} value={c.id}>
              {labelOf(c.id)}: {c.caption.trim().slice(0, 40) || '(no line)'}
            </option>
          ))}
        </Select>
        <Button size="sm" disabled={!scene || !scene.caption.trim()} busy={writing} onClick={() => writeShot()}>
          Write the shot
        </Button>
      </div>

      <Textarea
        rows={4}
        aria-label="What the shot shows"
        maxLength={1000}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="A steaming kettle on a roadside stall at dawn; warm light; slow push in; real footage, shallow focus."
        className="text-xs"
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="w-28">
          <Segmented label="Length" value={seconds} onChange={setSeconds} options={[{ id: '5', label: '5s' }, { id: '10', label: '10s' }]} />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-ink-2" title="The clip starts from the picture at the playhead and moves on from there">
          <input type="checkbox" className="h-3.5 w-3.5" checked={fromFrame} disabled={ed.clips.length === 0} onChange={(e) => setFromFrame(e.target.checked)} />
          Start from the frame at the playhead
        </label>
      </div>

      {error && (
        <p role="alert" className="text-xs text-bad">
          {error}
        </p>
      )}

      <Button variant="primary" size="sm" full disabled={prompt.trim().length < 10 || need > left} onClick={make}>
        <Film aria-hidden="true" className="h-4 w-4" />
        {need > left ? 'Not enough seconds left this month' : `Make the clip · uses ${need}s`}
      </Button>

      {made.length > 0 && (
        <ul className="space-y-1.5" aria-label="Clips made with AI">
          {made.map((m) => (
            <li key={m.id} className={cx('rounded-md border border-line px-2.5 py-2 text-xs', m.status === 'failed' && 'border-bad/40')}>
              <p className="line-clamp-2 text-ink-2">{m.prompt}</p>
              <div className="mt-1.5 flex items-center justify-between gap-2">
                {m.status === 'running' && (
                  <span className="flex items-center gap-1.5 text-ink-3">
                    <Spinner className="h-3 w-3" /> Making it. Usually a minute or two.
                  </span>
                )}
                {m.status === 'failed' && <span className="text-bad">{m.message ?? 'It could not be made.'}</span>}
                {m.status === 'ready' && (
                  <>
                    <span className="text-good">In your media{m.name ? ` as ${m.name}` : ''}.</span>
                    {m.name && m.sceneId && ed.clips.some((c) => c.id === m.sceneId) && (
                      <Button
                        size="xs"
                        onClick={() => {
                          const target = ed.clips.find((c) => c.id === m.sceneId)!;
                          ed.actions.placeOverlay(m.name!, target.start);
                          toast(`Cut in over ${labelOf(target.id)}.`);
                        }}
                      >
                        Cut in over {labelOf(m.sceneId)}
                      </Button>
                    )}
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
