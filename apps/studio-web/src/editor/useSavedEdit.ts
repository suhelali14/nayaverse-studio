import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { mediaFor } from './mediaStore';
import type { EditDoc, Editor, MediaItem } from './useEditor';

/**
 * The reel's edit, opened and saved as it is made.
 *
 * On open: the saved edit is fetched, the media it names is restored from
 * this browser's own storage, and the edit becomes the editor's starting
 * point. What is not stored here is listed as offline, and comes back the
 * moment a file of the same name is imported -- Premiere's relink, by name.
 *
 * While editing: a second after each change the edit is saved, one save at
 * a time -- a change made while a save is in flight is saved straight after
 * it, never alongside it, which would make the editor conflict with itself.
 * A save refused because another tab saved first stops autosave and says
 * so, rather than overwrite that tab's work. Closing the tab sends the last
 * change on its way.
 */

export type SaveState = 'opening' | 'unopened' | 'saved' | 'unsaved' | 'saving' | 'error' | 'conflict';

const DEBOUNCE_MS = 1000;

export function useSavedEdit(projectId: string, ed: Editor) {
  const [state, setState] = useState<SaveState>('opening');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  // Media the saved edit names that this browser does not have.
  const [offline, setOffline] = useState<MediaItem[]>([]);

  const edRef = useRef(ed);
  edRef.current = ed;
  const offlineRef = useRef(offline);
  offlineRef.current = offline;
  const revision = useRef(0);
  const ready = useRef(false);
  const baseline = useRef<string | null>(null);
  const inFlight = useRef(false);
  const again = useRef(false);
  const stopped = useRef(false);

  /** The edit to save: the editor's snapshot, still naming offline media. */
  const current = useCallback((): EditDoc => {
    const doc = edRef.current.snapshot();
    const have = new Set(doc.media.map((m) => m.name));
    return { ...doc, media: [...doc.media, ...offlineRef.current.filter((m) => !have.has(m.name))] };
  }, []);

  const flush = useCallback(async () => {
    if (!ready.current || stopped.current) return;
    if (inFlight.current) {
      again.current = true;
      return;
    }
    const doc = current();
    const json = JSON.stringify(doc);
    if (json === baseline.current) {
      setState('saved');
      return;
    }
    inFlight.current = true;
    setState('saving');
    try {
      const out = await api.saveEdit(projectId, revision.current, doc);
      revision.current = out.revision;
      baseline.current = json;
      setSavedAt(out.savedAt);
      setState('saved');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        stopped.current = true;
        setState('conflict');
      } else setState('error');
    } finally {
      inFlight.current = false;
    }
    if (again.current && !stopped.current) {
      again.current = false;
      void flush();
    }
  }, [projectId, current]);

  // Open.
  useEffect(() => {
    let cancelled = false;
    ready.current = false;
    stopped.current = false;
    baseline.current = null;
    setState('opening');
    void (async () => {
      try {
        const res = await api.getEdit(projectId);
        if (cancelled) return;
        revision.current = res.revision;
        setSavedAt(res.savedAt);
        const doc = res.doc as EditDoc | null;
        if (doc && doc.version === 1) {
          const { found, missing } = await mediaFor(projectId, doc.media.map((m) => m.name));
          if (cancelled) return;
          // Already kept here: loading them must not write them again.
          await edRef.current.actions.load(found, false, false);
          if (cancelled) return;
          edRef.current.actions.restore(doc);
          setOffline(doc.media.filter((m) => missing.includes(m.name)));
        }
        ready.current = true;
        setState('saved');
      } catch {
        if (!cancelled) {
          // Opened empty: saving now could overwrite an edit we failed to read.
          stopped.current = true;
          setState('unopened');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Relinked: an offline file imported again under its own name.
  useEffect(() => {
    if (offline.length === 0) return;
    const have = new Set(ed.library.map((m) => m.name));
    if (offline.some((m) => have.has(m.name))) setOffline((o) => o.filter((m) => !have.has(m.name)));
  }, [ed.library, offline]);

  // Save a second after the last change.
  useEffect(() => {
    if (!ready.current || stopped.current) return;
    const json = JSON.stringify(current());
    // The first look after opening is the baseline, not a change.
    if (baseline.current === null) {
      baseline.current = json;
      return;
    }
    if (json === baseline.current) return;
    setState('unsaved');
    const timer = window.setTimeout(() => void flush(), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [ed.timeline, ed.markers, ed.captionStyle, ed.library, offline, current, flush]);

  // Leaving: the last change goes with the tab.
  useEffect(() => {
    const leave = () => {
      if (!ready.current || stopped.current) return;
      const doc = current();
      if (JSON.stringify(doc) !== baseline.current) api.saveEditOnLeave(projectId, revision.current, doc);
    };
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      // Leaving the editor for another page of the app.
      leave();
    };
  }, [projectId, current]);

  return { state, savedAt, offline, retry: () => {
    stopped.current = false;
    void flush();
  } };
}
