import {
  ArrowLeft,
  Captions as CaptionsIcon,
  Download,
  FileText,
  Check,
  CloudOff,
  Images,
  Keyboard,
  Languages,
  LayoutList,
  Pause,
  Play,
  Redo2,
  SkipBack,
  SkipForward,
  Sparkles,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Mark } from '../components/chrome';
import { Badge, Button, IconButton, Segmented, Select, cx, useToast } from '../components/ui';
import { ApiError, api, type AiStatus, type Job, type PlanResult, type Project } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatMoney, languageOf, useCatalogue } from '../lib/catalogue';
import { CAPTION_FACE, useEditor } from '../editor/useEditor';
import { canExport, download, exportTimeline, type ExportPreset } from '../editor/export';
import { ExportPanel } from '../editor/ExportPanel';
import { mixVoices } from '../editor/audio';
import { withOverlay } from '../editor/layers';
import { fade, look } from '../editor/effects';
import { VideoSampleSink, type VideoCodec, type VideoSample } from 'mediabunny';
import { Director } from '../editor/Director';
import { Inspector } from '../editor/Inspector';
import { MediaBin } from '../editor/MediaBin';
import { Scenes } from '../editor/RunningOrder';
import { Timeline } from '../editor/Timeline';
import { Shortcuts } from '../editor/Shortcuts';
import { Polish } from '../editor/Polish';
import { keepMedia } from '../editor/mediaStore';
import { useSavedEdit, type SaveState } from '../editor/useSavedEdit';
import { Generate } from '../editor/Generate';
import { viewerMenu } from '../editor/menus';
import { useContextMenu } from '../components/ContextMenu';
import { scriptKey } from '../lib/handoff';
import { formatClock, formatTimecode } from '../editor/time';
import { billedMinutes } from '../../../studio/src/lib/metering.js';
import { FRAME_FPS, composeFrame } from '../../../studio/src/lib/compose.js';
import type { DirectedReel, LibraryItem } from '../../../studio/src/lib/director.js';
import type { Theme } from '../../../studio/src/domain/workspace.js';
import { captionAt } from '../../../studio/src/lib/subtitles.js';
import type { Clip } from '../../../studio/src/lib/timeline.js';

/**
 * One reel, as an editing workspace.
 *
 *   top bar     back to the reels, the reel's name, Export
 *   left        a tool rail -- Script, Media, Scenes, Captions, Dub -- and
 *               the panel for the tool chosen
 *   centre      the viewer, frame-exact, with the transport under it
 *   right       the inspector: the selected clip, or the reel
 *   bottom      the timeline: video and captions on one clock
 *
 * The editor's state and every operation on it live in `useEditor`; the
 * panels are in `src/editor/`. This file wires them together and owns the
 * things that talk to the server: jobs, the Script panel's model calls
 * (through the Director) and the dub request.
 */

const isOpen = (j: Job) => j.status === 'queued' || j.status === 'running';

type Tool = 'script' | 'media' | 'scenes' | 'captions' | 'polish' | 'dub';

const TOOLS: readonly { id: Tool; label: string; icon: LucideIcon }[] = [
  { id: 'script', label: 'Script', icon: FileText },
  { id: 'media', label: 'Media', icon: Images },
  { id: 'scenes', label: 'Scenes', icon: LayoutList },
  { id: 'captions', label: 'Captions', icon: CaptionsIcon },
  { id: 'polish', label: 'Polish', icon: Sparkles },
  { id: 'dub', label: 'Dub', icon: Languages },
];

function PanelSection({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="panel-head">
        <span>{title}</span>
        {aside !== undefined && <span className="text-xs font-normal text-ink-3">{aside}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

/**
 * Where the edit stands, in a few words beside its name: the reassurance a
 * desktop editor gives by saving where you can see it.
 */
function SaveStatus({ state, savedAt, onRetry }: { state: SaveState; savedAt: string | null; onRetry: () => void }) {
  const when = savedAt ? new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  if (state === 'opening') return <span className="hidden shrink-0 text-xs text-ink-3 sm:inline">Opening…</span>;
  if (state === 'saved') {
    return (
      <span className="hidden shrink-0 items-center gap-1 text-xs text-ink-3 sm:inline-flex" title={when ? `Saved at ${when}` : 'Saved'}>
        <Check aria-hidden="true" className="h-3 w-3" />
        Saved
      </span>
    );
  }
  if (state === 'unsaved' || state === 'saving') return <span className="shrink-0 text-xs text-ink-3">Saving…</span>;
  if (state === 'conflict') {
    return (
      <button type="button" onClick={() => window.location.reload()} className="shrink-0 text-xs font-medium text-warn underline">
        Changed in another tab. Reload
      </button>
    );
  }
  if (state === 'unopened') {
    return (
      <button type="button" onClick={() => window.location.reload()} className="shrink-0 text-xs font-medium text-bad underline">
        Couldn't open the saved edit. Reload
      </button>
    );
  }
  return (
    <button type="button" onClick={onRetry} className="shrink-0 text-xs font-medium text-bad underline">
      Not saved. Retry
    </button>
  );
}

export default function ProjectEditor() {
  const { id = '' } = useParams();
  const toast = useToast();
  const { account } = useAuth();
  const { catalogue } = useCatalogue();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Every imported file is kept in this browser, so the saved edit reopens
  // with its pictures; see editor/mediaStore.ts.
  const ed = useEditor(canvasRef, { keep: (file) => void keepMedia(id, file) });
  const saved = useSavedEdit(id, ed);
  const relink = useRef<HTMLInputElement | null>(null);

  const [tool, setTool] = useState<Tool>('script');
  // A line the right-click menu asked for an AI shot of.
  const [shotFor, setShotFor] = useState<string | null>(null);
  useEffect(() => {
    const ask = (e: Event) => {
      setTool('media');
      setShotFor((e as CustomEvent<string>).detail);
    };
    window.addEventListener('studio:shot-for', ask);
    return () => window.removeEventListener('studio:shot-for', ask);
  }, []);
  // A script handed over from Ideas: read once, then forgotten, so a reload
  // does not keep re-filling the Script panel.
  const [handedScript] = useState<string | undefined>(() => {
    try {
      const key = scriptKey(id);
      const value = sessionStorage.getItem(key) ?? undefined;
      sessionStorage.removeItem(key);
      return value;
    } catch {
      return undefined;
    }
  });
  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dubLanguage, setDubLanguage] = useState('hi');
  const [dubLipSync, setDubLipSync] = useState(true);

  // --- loading -------------------------------------------------------------

  const reload = useCallback(async () => {
    try {
      setProject(await api.project(id));
      setLoadError(null);
    } catch (e) {
      // The API may not be running. Say so plainly -- the editor itself
      // works offline, so this must not blank the page.
      setLoadError(e instanceof ApiError ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    // Unreachable means "split only", which the Script panel handles; it is
    // not an error worth a toast on every editor load.
    api.aiStatus().then(setAi, () => setAi(null));
  }, []);

  /**
   * Poll only while something is actually running.
   *
   * An interval that keeps ticking on an idle editor is a cost with no
   * benefit, and one that keeps ticking in a background tab is worse.
   */
  const busy = jobs.some(isOpen);
  useEffect(() => {
    if (!busy) return;
    let alive = true;
    const beat = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const next = await api.jobs(id);
        if (!alive) return;
        setJobs(next);
        const done = next.find((j) => j.kind === 'transcribe' && j.status === 'done');
        if (done) await adoptTranscript();
      } catch {
        /* a failed poll is not worth a toast on every beat */
      }
    };
    const timer = setInterval(() => void beat(), 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, id]);

  const adoptTranscript = useCallback(async () => {
    try {
      const t = await api.transcript(id);
      const first = ed.clips.find((c) => c.source.kind === 'clip');
      if (first && first.source.kind === 'clip') {
        ed.actions.applyWords(first.source.path, t.words);
        toast(`Captions from ${t.words.length} words`);
      }
    } catch (e) {
      toast(e instanceof ApiError ? e.message : String(e), 'bad');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, ed.clips]);

  // --- the Script panel ----------------------------------------------------

  /**
   * Scenes the Script panel placed that nobody has looked at yet: marked New
   * until played or selected, so a re-cut announces itself.
   */
  const [unseen, setUnseen] = useState<ReadonlySet<string>>(new Set());
  const markPlaced = useRef(false);

  const onDirect = (reel: DirectedReel, result: PlanResult) => {
    markPlaced.current = true;
    setPlan(result);
    ed.actions.direct(reel);
  };

  useEffect(() => {
    if (!markPlaced.current) return;
    markPlaced.current = false;
    setUnseen(new Set(ed.clips.map((c) => c.id)));
  }, [ed.clips]);

  const nowId = ed.clips.find((c) => ed.playhead >= c.start && ed.playhead < c.start + c.duration)?.id;
  useEffect(() => {
    setUnseen((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      if (nowId) next.delete(nowId);
      if (ed.selected) next.delete(ed.selected);
      return next.size === prev.size ? prev : next;
    });
  }, [nowId, ed.selected]);

  // --- the frame at the playhead -------------------------------------------

  const [keysOpen, setKeysOpen] = useState(false);
  const frameName = () =>
    `${(project?.title || 'reel').replace(/[^\p{L}\p{N}]+/gu, '-')}-${formatTimecode(ed.playhead, FRAME_FPS).replace(/[:;]/g, '-')}.png`;
  const saveFrame = () => {
    canvasRef.current?.toBlob((b) => b && download(b, frameName()), 'image/png');
  };
  const copyFrame = () => {
    canvasRef.current?.toBlob(async (b) => {
      if (!b) return;
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]);
        toast('Frame copied.');
      } catch {
        toast('This browser cannot copy pictures. Save the frame as PNG instead.', 'bad');
      }
    }, 'image/png');
  };
  const openMenu = useContextMenu();
  const edRef = useRef(ed);
  edRef.current = ed;

  // --- keyboard ------------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement || t instanceof HTMLSelectElement) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      // Clipboard keys act on clips only when no text on the page is selected.
      const textSelected = !(window.getSelection()?.isCollapsed ?? true);
      if (mod && !e.shiftKey && key === 'c' && ed.selected && !textSelected) {
        e.preventDefault();
        ed.actions.copy();
        return;
      }
      if (mod && key === 'x' && ed.selected && !textSelected) {
        e.preventDefault();
        ed.actions.copy();
        ed.actions.remove();
        return;
      }
      if (mod && key === 'v' && ed.canPaste) {
        e.preventDefault();
        ed.actions.paste();
        return;
      }
      if (mod && key === 'd') {
        e.preventDefault();
        ed.actions.duplicate();
        return;
      }
      if (mod && key === 'e') {
        e.preventDefault();
        setExportOpen(true);
        return;
      }
      if (mod && e.shiftKey && key === 's') {
        e.preventDefault();
        saveFrame();
        return;
      }
      if (e.altKey && !mod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        ed.actions.move(e.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        setKeysOpen(true);
        return;
      }
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) ed.actions.redo();
        else ed.actions.undo();
        return;
      }
      if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        ed.actions.redo();
        return;
      }
      // Single-key shortcuts only: Ctrl+S must not split a clip.
      if (mod || e.altKey) return;
      if (e.key === ' ') {
        e.preventDefault();
        ed.actions.togglePlay();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // Handled, so the browser must not also scroll the page sideways.
        e.preventDefault();
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        ed.actions.step(dir * (e.shiftKey ? FRAME_FPS : 1));
      } else if (e.key === 's' || e.key === 'S') ed.actions.split();
      // J/K/L, as every editor has them: back, stop, forward; again for faster.
      else if (e.key === 'l' || e.key === 'L') ed.actions.shuttle(ed.playing && ed.rate > 0 ? Math.min(4, ed.rate * 2) : 1);
      else if (e.key === 'j' || e.key === 'J') ed.actions.shuttle(ed.playing && ed.rate < 0 ? Math.max(-4, ed.rate * 2) : -1);
      else if (e.key === 'k' || e.key === 'K') ed.actions.shuttle(0);
      else if (e.key === 'm' || e.key === 'M') ed.actions.toggleMarker();
      else if (e.key === 'q' || e.key === 'Q') ed.actions.trimToPlayhead('in');
      else if (e.key === 'w' || e.key === 'W') ed.actions.trimToPlayhead('out');
      else if (e.key === 't' || e.key === 'T') ed.actions.addCard();
      else if (e.key === 'Home') {
        e.preventDefault();
        ed.actions.seek(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        ed.actions.seek(ed.total);
      }
      else if (e.key === 'Delete' || e.key === 'Backspace') ed.actions.remove();
      else if (e.key === 'Escape') ed.actions.select(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ed.actions, ed.playing, ed.rate, ed.total, ed.selected, ed.canPaste]);

  // --- export --------------------------------------------------------------

  const [exportOpen, setExportOpen] = useState(false);
  const cancelExport = useRef(false);
  const hasSound = ed.voices().length > 0;

  const runExport = async (preset: ExportPreset, codec: VideoCodec, withSound: boolean) => {
    const check = await canExport();
    if (!check.ok) {
      toast(check.why, 'bad');
      return;
    }
    const totalFrames = Math.round(ed.total * FRAME_FPS);
    if (totalFrames === 0) {
      toast('Add something to the timeline first.', 'bad');
      return;
    }
    cancelExport.current = false;
    setExporting(true);
    try {
      const clips = ed.clips;

      // The same voices the preview plays: main-track sound at each clip's
      // volume, the music track, mutes respected.
      const audio = withSound ? await mixVoices(ed.voices(), ed.total) : null;
      const overlays = ed.overlayClips;

      /**
       * Full-resolution frames, one clip at a time. Each video clip gets its
       * own decoder that walks its source in order, asked for exactly the
       * frames the export needs; the preview's scrub cache, which keeps
       * smaller copies, is never used for the file. Each frame is closed as
       * soon as the next is in hand, so the decoder's pool never runs dry.
       */
      // Cast, not annotated: assigned only inside the closures below, which
      // TypeScript would otherwise narrow to the initial null.
      let reading = null as { index: number; samples: AsyncGenerator<VideoSample | null> } | null;
      let held = null as { sample: VideoSample; frame: VideoFrame } | null;
      let overReading = null as { id: string; samples: AsyncGenerator<VideoSample | null> } | null;
      let overHeld = null as { sample: VideoSample; frame: VideoFrame } | null;
      const release = () => {
        held?.frame.close();
        held?.sample.close();
        held = null;
      };
      const stopReading = async () => {
        if (reading) await reading.samples.return(undefined);
        reading = null;
      };
      const releaseOver = async () => {
        overHeld?.frame.close();
        overHeld?.sample.close();
        overHeld = null;
        if (overReading) await overReading.samples.return(undefined);
        overReading = null;
      };

      const frames = (async function* () {
        try {
          for (let f = 0; f < totalFrames; f += 1) {
            const time = f / FRAME_FPS;
            let found: { clip: Clip; index: number; local: number } | null = null;
            for (let i = 0; i < clips.length; i += 1) {
              const c = clips[i]!;
              if (time >= c.start && time < c.start + c.duration) {
                found = { clip: c, index: i, local: time - c.start };
                break;
              }
            }
            if (!found) continue;
            const sources = new Map<string, unknown>();
            const { clip, index, local } = found;
            if (clip.source.kind === 'photo' || clip.source.kind === 'asset') {
              const still = ed.stills.current.get(clip.source.path);
              if (still) sources.set(clip.source.path, still.bitmap);
            } else if (clip.source.kind === 'clip') {
              const loaded = ed.loadedClips.current.get(clip.source.path);
              if (loaded && reading?.index !== index) {
                await stopReading();
                const sink = new VideoSampleSink(loaded.source.track);
                const last = clip.sourceIn + clip.duration - 1 / FRAME_FPS;
                const count = Math.ceil(clip.duration * FRAME_FPS) + 1;
                const speed = clip.speed ?? 1;
                const lastAt = clip.sourceIn + clip.duration * speed - 1 / FRAME_FPS;
                const times = Array.from({ length: count }, (_, k) => Math.min(Math.max(last, lastAt), clip.sourceIn + (k * speed) / FRAME_FPS));
                reading = { index, samples: sink.samplesAtTimestamps(times) };
              }
              const next = reading ? await reading.samples.next() : null;
              const sample = next && !next.done ? next.value : null;
              if (sample) {
                release();
                held = { sample, frame: sample.toVideoFrame() };
              }
              if (held) sources.set(clip.source.path, held.frame);
            }
            const size =
              clip.source.kind === 'clip'
                ? (ed.loadedClips.current.get(clip.source.path)?.size ?? null)
                : clip.source.kind === 'solid'
                  ? null
                  : (ed.stills.current.get(clip.source.path)?.size ?? null);
            const auto = ed.cues.length > 0 ? captionAt(ed.cues, time * 1000) : null;
            let spec = look(
              composeFrame({
                shot: { seconds: clip.duration, caption: clip.caption, source: clip.source },
                index,
                t: local,
                seconds: clip.duration,
                theme: ed.theme as Theme,
                source: size,
                ...(auto === null ? {} : { captionOverride: auto }),
              }),
              clip,
              local,
            );

            // The overlay track, read at full resolution like the main one.
            const over = overlays.find((c) => time >= c.start && time < c.start + c.duration);
            if (!over && overReading) await releaseOver();
            if (over && over.source.kind !== 'solid') {
              let overSize: { w: number; h: number } | null = null;
              if (over.source.kind === 'clip') {
                const loaded = ed.loadedClips.current.get(over.source.path);
                if (loaded && overReading?.id !== over.id) {
                  await releaseOver();
                  const last = over.sourceIn + over.duration - 1 / FRAME_FPS;
                  const count = Math.ceil(over.duration * FRAME_FPS) + 1;
                  const startAt = Math.max(0, time - over.start);
                  const speed = over.speed ?? 1;
                  const lastAt = over.sourceIn + over.duration * speed - 1 / FRAME_FPS;
                  const times = Array.from({ length: count }, (_, k) =>
                    Math.min(Math.max(last, lastAt), over.sourceIn + (startAt + k / FRAME_FPS) * speed),
                  );
                  overReading = { id: over.id, samples: new VideoSampleSink(loaded.source.track).samplesAtTimestamps(times) };
                }
                const next = overReading ? await overReading.samples.next() : null;
                const sample = next && !next.done ? next.value : null;
                if (sample) {
                  overHeld?.frame.close();
                  overHeld?.sample.close();
                  overHeld = { sample, frame: sample.toVideoFrame() };
                }
                if (loaded && overHeld) {
                  overSize = loaded.size;
                  sources.set(over.source.path, overHeld.frame);
                }
              } else {
                const still = ed.stills.current.get(over.source.path);
                if (still) {
                  overSize = still.size;
                  sources.set(over.source.path, still.bitmap);
                }
              }
              if (overSize) {
                spec = withOverlay(
                  spec,
                  look(
                    composeFrame({
                      shot: { seconds: over.duration, caption: '', source: over.source },
                      index: 1,
                      t: time - over.start,
                      seconds: over.duration,
                      theme: ed.theme as Theme,
                      source: overSize,
                      captionOverride: '',
                    }),
                    over,
                    time - over.start,
                  ),
                );
              }
            }
            yield { spec: fade(spec, clip, local), sources };
          }
        } finally {
          release();
          await stopReading();
          await releaseOver();
        }
      })();

      const result = await exportTimeline({
        frames,
        totalFrames,
        fontFamily: CAPTION_FACE,
        width: preset.width,
        height: preset.height,
        bitrate: preset.bitrate,
        codec,
        audio,
        onProgress: (p) => setProgress(p.frame / p.totalFrames),
        shouldCancel: () => cancelExport.current,
      });
      if (result.cancelled) {
        toast('Export cancelled.');
        return;
      }
      download(result.blob, `${project?.title ?? 'studio'}-${preset.id}.mp4`);
      setExportOpen(false);
      toast(
        `Exported ${result.seconds.toFixed(1)}s at ${preset.width}×${preset.height}${result.hasAudio ? ' with sound' : ', no sound'}.`,
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'bad');
    } finally {
      setExporting(false);
      setProgress(0);
    }
  };

  // --- what each tool has produced, for the rail ---------------------------

  const languageName = (code: string) => (catalogue ? languageOf(catalogue, code)?.english : undefined) ?? code;
  const transcribing = jobs.find((j) => j.kind === 'transcribe' && isOpen(j));
  const dubJob = [...jobs].reverse().find((j): j is Extract<Job, { kind: 'dub' }> => j.kind === 'dub');
  const typed = ed.clips.some((c) => c.caption.trim().length > 0);

  const done: Record<Tool, boolean> = {
    script: plan !== null || typed,
    media: ed.library.length > 0,
    scenes: ed.clips.length > 0,
    captions: ed.cues.length > 0,
    polish: false,
    dub: dubJob?.status === 'done',
  };
  const working: Partial<Record<Tool, boolean>> = {
    captions: transcribing !== undefined,
    dub: dubJob !== undefined && isOpen(dubJob),
  };

  // --- dubbing, priced before anything is spent ----------------------------

  const region = account?.region ?? catalogue?.regions[0]?.id ?? 'IN';
  const target = catalogue ? languageOf(catalogue, dubLanguage) : undefined;
  const lipSync = dubLipSync && (target?.lipSync ?? false);
  const minutes = billedMinutes(ed.total);
  const dubPrice = catalogue ? formatMoney(catalogue, region, catalogue.metered.dubMinute[region] * minutes) : null;

  const sceneIndex = nowId ? ed.clips.findIndex((c) => c.id === nowId) : -1;
  const title = project?.title ?? 'Untitled reel';

  const panelFor = (which: Tool): ReactNode => {
    switch (which) {
      case 'script':
        return (
          <PanelSection title="Script" aside={ai?.write ? 'AI ready' : undefined}>
            <Director
              status={ai}
              library={ed.library.filter((x): x is LibraryItem => x.kind !== 'audio')}
              languages={catalogue?.languages ?? []}
              defaultLanguage={project?.language ?? 'en'}
              hasCut={ed.clips.length > 0}
              onDirect={onDirect}
              initialScript={handedScript}
            />
          </PanelSection>
        );
      case 'media':
        return (
          <PanelSection title="Media" aside={ed.library.length > 0 ? `${ed.library.length} items` : undefined}>
            <Generate
              ed={ed}
              topic={project?.title ?? ''}
              frame={() => canvasRef.current?.toDataURL('image/jpeg', 0.85) ?? null}
              requestFor={shotFor}
              onRequestTaken={() => setShotFor(null)}
            />
            <MediaBin ed={ed} />
          </PanelSection>
        );
      case 'scenes':
        return (
          <PanelSection title="Scenes" aside={`${ed.clips.length}`}>
            <Scenes ed={ed} unseen={unseen} />
          </PanelSection>
        );
      case 'captions':
        return (
          <PanelSection title="Captions" aside={`${ed.cues.length}`}>
            <div className="space-y-2 border-b border-line p-4">
              <Button
                size="sm"
                full
                disabled
                title="Transcribing speech is coming soon"
                busy={transcribing !== undefined}
                onClick={async () => {
                  try {
                    const job = await api.transcribe(id, { language: null });
                    setJobs((j) => [...j.filter((x) => x.id !== job.id), job]);
                    toast('Transcribing the audio…');
                  } catch (e) {
                    toast(e instanceof ApiError ? e.message : String(e), 'bad');
                  }
                }}
              >
                <CaptionsIcon aria-hidden="true" className="h-4 w-4" />
                Transcribe speech
              </Button>
              <p className="text-2xs leading-relaxed text-ink-3">
                Coming soon. Until then, captions are timed from your script.
              </p>
            </div>
            <div className="space-y-2.5 border-b border-line p-4">
              <p className="text-xs font-semibold text-ink">Style</p>
              <Segmented
                label="Caption size"
                value={ed.captionStyle.size}
                onChange={(size) => ed.actions.setCaptionStyle({ ...ed.captionStyle, size })}
                options={[
                  { id: 'S' as const, label: 'Small' },
                  { id: 'M' as const, label: 'Medium' },
                  { id: 'L' as const, label: 'Large' },
                ]}
              />
              <Segmented
                label="Caption position"
                value={ed.captionStyle.position}
                onChange={(position) => ed.actions.setCaptionStyle({ ...ed.captionStyle, position })}
                options={[
                  { id: 'low' as const, label: 'Lower third' },
                  { id: 'middle' as const, label: 'Centre' },
                ]}
              />
              <Segmented
                label="Caption colour"
                value={ed.captionStyle.colour}
                onChange={(colour) => ed.actions.setCaptionStyle({ ...ed.captionStyle, colour })}
                options={[
                  { id: 'white' as const, label: 'White' },
                  { id: 'yellow' as const, label: 'Yellow' },
                ]}
              />
            </div>
            {ed.cues.length === 0 ? (
              <p className="px-4 py-8 text-center text-xs text-ink-3">
                Captions appear here once the reel is made or the speech is transcribed.
              </p>
            ) : (
              <ol className="divide-y divide-line">
                {ed.cues.map((cue, i) => {
                  const live = ed.playhead * 1000 >= cue.startMs && ed.playhead * 1000 < cue.endMs;
                  return (
                    <li key={i}>
                      <button
                        type="button"
                        onClick={() => ed.actions.seek(cue.startMs / 1000)}
                        className={cx(
                          'grid w-full grid-cols-[52px_minmax(0,1fr)] gap-2 px-4 py-2 text-left text-xs hover:bg-panel-2',
                          live && 'bg-panel-2',
                        )}
                      >
                        <time className={live ? 'text-accent' : 'text-ink-3'}>{formatClock(cue.startMs / 1000)}</time>
                        <span className="text-ink-2">{cue.lines.join(' ')}</span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}
          </PanelSection>
        );
      case 'polish':
        return (
          <PanelSection title="Polish">
            <Polish ed={ed} language={project?.language ?? 'en'} />
          </PanelSection>
        );
      case 'dub':
        return (
          <PanelSection title="Dub" aside={<Badge tone="warn">Coming soon</Badge>}>
            <div className="space-y-3 p-4">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-ink-2">Language</span>
                <Select compact value={dubLanguage} onChange={(e) => setDubLanguage(e.target.value)}>
                  {(catalogue?.languages ?? []).map((t) => (
                    <option key={t.code} value={t.code}>
                      {t.native === t.english ? t.english : `${t.native} · ${t.english}`}
                      {t.lipSync ? '' : ' (voice only)'}
                    </option>
                  ))}
                </Select>
              </label>

              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={lipSync}
                  disabled={!target?.lipSync}
                  onChange={(e) => setDubLipSync(e.target.checked)}
                  className="h-3.5 w-3.5"
                />
                <span className={target?.lipSync ? 'text-ink-2' : 'text-ink-3'}>Match lip movement</span>
              </label>
              {target && !target.lipSync && (
                <p className="text-2xs text-warn">{target.english} gets a dubbed voice without lip-sync.</p>
              )}

              {dubPrice && (
                <dl className="rounded-md bg-panel-2 px-3 py-2 text-xs">
                  <div className="flex justify-between">
                    <dt className="text-ink-3">Billed length</dt>
                    <dd className="tabular text-ink">
                      {minutes} min
                    </dd>
                  </div>
                  <div className="mt-1 flex justify-between">
                    <dt className="text-ink-3">Beyond your included minutes, at launch</dt>
                    <dd className="tabular font-semibold text-ink">{dubPrice}</dd>
                  </div>
                </dl>
              )}
              <Button
                variant="primary"
                size="sm"
                full
                disabled
                title="Dubbing is coming soon"
                onClick={async () => {
                  try {
                    const job = await api.dub(id, { language: dubLanguage, lipSync });
                    setJobs((j) => [...j.filter((x) => x.id !== job.id), job]);
                    toast(`Dubbing into ${target?.english ?? dubLanguage}…`);
                  } catch (e) {
                    toast(e instanceof ApiError ? e.message : String(e), 'bad');
                  }
                }}
              >
                <Languages aria-hidden="true" className="h-4 w-4" />
                Dub this reel
              </Button>
            </div>
            {jobs.length > 0 && (
              <div className="border-t border-line">
                <div className="px-4 pt-3 text-xs font-semibold text-ink">Jobs</div>
                <ul className="divide-y divide-line">
                  {jobs.map((j) => (
                    <li key={j.id} className="flex items-center justify-between gap-3 px-4 py-2 text-xs">
                      <span className="text-ink-2">
                        {j.kind === 'dub' && j.language ? `Dub · ${languageName(j.language)}` : j.kind === 'transcribe' ? 'Transcription' : 'Render'}
                      </span>
                      <Badge tone={j.status === 'failed' ? 'bad' : j.status === 'done' ? 'good' : 'warn'}>{j.status}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </PanelSection>
        );
    }
  };

  return (
    <div className="flex flex-col bg-ground lg:h-[100dvh] lg:overflow-hidden">
      {/* Top bar */}
      <header className="order-first flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel px-2 sm:px-3">
        <Link
          to="/app"
          aria-label="Back to reels"
          title="Back to reels"
          className="flex h-8 w-8 items-center justify-center rounded-md text-ink-2 hover:bg-panel-2 hover:text-ink"
        >
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
        </Link>
        <Mark className="h-5 w-5" />
        <div className="ml-1 flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-semibold text-ink">{title}</span>
          <span className="tabular hidden shrink-0 text-xs text-ink-3 sm:inline">
            {ed.total.toFixed(1)}s · 9:16
          </span>
          <SaveStatus state={saved.state} savedAt={saved.savedAt} onRetry={saved.retry} />
        </div>
        <span className="flex-1" />
        <div className="flex items-center gap-0.5 border-r border-line pr-2">
          <IconButton small label="Undo (Ctrl+Z)" disabled={!ed.canUndo} onClick={ed.actions.undo}>
            <Undo2 aria-hidden="true" className="h-4 w-4" />
          </IconButton>
          <IconButton small label="Redo (Ctrl+Shift+Z)" disabled={!ed.canRedo} onClick={ed.actions.redo}>
            <Redo2 aria-hidden="true" className="h-4 w-4" />
          </IconButton>
          <IconButton small label="Keyboard shortcuts (?)" onClick={() => setKeysOpen(true)}>
            <Keyboard aria-hidden="true" className="h-4 w-4" />
          </IconButton>
        </div>
        <Shortcuts open={keysOpen} onClose={() => setKeysOpen(false)} />
        <div className="relative">
          <Button
            variant="primary"
            size="sm"
            aria-haspopup="dialog"
            aria-expanded={exportOpen}
            onClick={() => setExportOpen((v) => !v)}
            aria-label={exporting ? `Exporting, ${Math.round(progress * 100)}%` : 'Export'}
          >
            <Download aria-hidden="true" className="h-4 w-4" />
            <span className="hidden sm:inline">{exporting ? `${Math.round(progress * 100)}%` : 'Export'}</span>
          </Button>
          <ExportPanel
            open={exportOpen}
            onClose={() => setExportOpen(false)}
            hasSound={hasSound}
            exporting={exporting}
            progress={progress}
            onExport={(preset, codec, withSound) => void runExport(preset, codec, withSound)}
            onCancel={() => {
              cancelExport.current = true;
            }}
          />
        </div>
      </header>

      {saved.offline.length > 0 && (
        <div role="status" className="order-first flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-warn/30 bg-warn-soft px-4 py-1.5 text-xs text-warn">
          <CloudOff aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">
            {saved.offline.length === 1 ? 'One file is' : `${saved.offline.length} files are`} not on this computer:{' '}
            <span className="font-medium">{saved.offline.map((m) => m.name).join(', ')}</span>. Import {saved.offline.length === 1 ? 'it' : 'them'} again
            under the same {saved.offline.length === 1 ? 'name' : 'names'} to relink.
          </span>
          <Button size="xs" onClick={() => relink.current?.click()}>
            Relink…
          </Button>
          <input
            ref={relink}
            type="file"
            multiple
            accept="video/*,image/*,audio/*"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              if (files.length) void ed.actions.load(files, false);
            }}
          />
        </div>
      )}

      {(ed.note?.bad || loadError) && (
        <p role="alert" className="order-first shrink-0 border-b border-bad/30 bg-bad-soft px-4 py-1.5 text-xs text-bad">
          {ed.note?.bad ? ed.note.text : `Couldn't load the project details: ${loadError}`}
        </p>
      )}

      <div className="contents lg:flex lg:min-h-0 lg:flex-1">
        {/* Tool rail */}
        <nav
          aria-label="Tools"
          className="order-3 flex shrink-0 border-y border-line bg-panel lg:order-none lg:w-16 lg:flex-col lg:gap-1 lg:border-y-0 lg:border-r lg:py-2"
        >
          {TOOLS.map((t) => {
            const on = tool === t.id;
            return (
              <button
                key={t.id}
                type="button"
                aria-pressed={on}
                onClick={() => setTool(t.id)}
                className={cx(
                  'relative flex h-14 flex-1 flex-col items-center justify-center gap-1 text-2xs font-medium transition-colors lg:mx-1.5 lg:flex-none lg:rounded-md',
                  on ? 'bg-panel-3 text-ink' : 'text-ink-3 hover:bg-panel-2 hover:text-ink',
                )}
              >
                <t.icon aria-hidden="true" className="h-[18px] w-[18px]" />
                {t.label}
                {(working[t.id] || done[t.id]) && (
                  <span
                    aria-hidden="true"
                    className={cx(
                      'absolute right-2.5 top-2 h-1.5 w-1.5 rounded-full',
                      working[t.id] ? 'animate-pulse bg-warn' : 'bg-good',
                    )}
                  />
                )}
                <span className="sr-only">{working[t.id] ? ', in progress' : done[t.id] ? ', done' : ''}</span>
              </button>
            );
          })}
        </nav>

        {/* Tool panel */}
        <aside
          id="tool-panel"
          aria-label={TOOLS.find((t) => t.id === tool)?.label}
          className="order-4 flex min-h-[320px] flex-col bg-panel lg:order-none lg:min-h-0 lg:w-[312px] lg:shrink-0 lg:border-r lg:border-line"
        >
          {/* Every panel stays mounted and only the chosen one shows, so a
              half-written script and its review survive a look at Scenes. */}
          {TOOLS.map((t) => (
            <div key={t.id} className={tool === t.id ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
              {panelFor(t.id)}
            </div>
          ))}
        </aside>

        {/* Viewer */}
        <section
          aria-label="Viewer"
          className="order-1 flex min-h-0 min-w-0 flex-1 flex-col bg-monitor lg:order-none"
        >
          <div className="relative flex min-h-0 flex-1 items-center justify-center p-4 lg:p-6">
            <canvas
              ref={canvasRef}
              width={1080}
              height={1920}
              className={cx(
                'h-auto w-auto max-w-full rounded-md ring-1 ring-white/10 lg:h-full lg:max-h-full',
                ed.clips.length === 0 ? 'max-h-[40vh]' : 'max-h-[56vh]',
              )}
              style={{ aspectRatio: '9 / 16' }}
              aria-label="Preview of the reel at the playhead"
              onContextMenu={(e) => openMenu(e, viewerMenu(() => edRef.current, { save: saveFrame, copy: copyFrame }), 'Viewer actions')}
            />
            {ed.clips.length === 0 && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
                <div className="pointer-events-auto max-w-[15rem] text-center">
                  <p className="text-sm font-medium text-ink">Start with a script</p>
                  <p className="mt-1 text-xs text-ink-3">Paste one, or add media and text cards.</p>
                  <Button
                    size="sm"
                    className="mt-3"
                    onClick={() => {
                      setTool('script');
                      document.getElementById('tool-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }}
                  >
                    Open the Script panel
                  </Button>
                </div>
              </div>
            )}
          </div>
          <div className="grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 border-t border-line bg-panel px-3">
            <span className="tabular truncate text-xs text-ink-2">{formatTimecode(ed.playhead, FRAME_FPS)}</span>
            <div className="flex items-center gap-1">
              <IconButton small label="Previous frame (Left arrow)" onClick={() => ed.actions.step(-1)}>
                <SkipBack aria-hidden="true" className="h-4 w-4" />
              </IconButton>
              <IconButton
                label={ed.playing ? 'Pause (Space)' : 'Play (Space)'}
                variant="secondary"
                className="rounded-full"
                onClick={ed.actions.togglePlay}
              >
                {ed.playing ? (
                  <Pause aria-hidden="true" className="h-4 w-4" />
                ) : (
                  <Play aria-hidden="true" className="ml-0.5 h-4 w-4" />
                )}
              </IconButton>
              <IconButton small label="Next frame (Right arrow)" onClick={() => ed.actions.step(1)}>
                <SkipForward aria-hidden="true" className="h-4 w-4" />
              </IconButton>
            </div>
            <span className="truncate text-right text-xs text-ink-3">
              {sceneIndex >= 0 ? `Clip ${sceneIndex + 1} of ${ed.clips.length}` : '1080×1920'}
            </span>
          </div>
        </section>

        {/* Inspector */}
        <aside
          aria-label="Inspector"
          className="order-5 bg-panel lg:order-none lg:w-[288px] lg:shrink-0 lg:overflow-y-auto lg:border-l lg:border-line"
        >
          <Inspector ed={ed} title={title} language={languageName(project?.language ?? 'en')} />
        </aside>
      </div>

      <div className="order-2 lg:order-none">
        <Timeline ed={ed} />
      </div>
    </div>
  );
}
