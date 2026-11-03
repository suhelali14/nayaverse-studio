import type { MenuEntry } from '../components/ContextMenu';
import type { Clip, Grade } from '../../../studio/src/lib/timeline.js';
import { LOOKS, NEUTRAL } from './effects';
import { MUSIC, type Editor } from './useEditor';

/**
 * What a right-click offers, per thing clicked.
 *
 * Every entry is also a keyboard shortcut, and says so. Entries call the
 * editor through `get()` at the moment they are chosen, not through a copy
 * taken when the menu opened: the right-click itself selects the clip, and
 * an action bound before that would act on the previous selection.
 */

export const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

const SPEEDS = [0.5, 1, 1.5, 2] as const;
const PUSH = { in: { from: 1, to: 1.15 }, out: { from: 1.15, to: 1 } } as const;

const sameGrade = (a: Grade, b: Grade) =>
  a.exposure === b.exposure && a.contrast === b.contrast && a.saturation === b.saturation && a.warmth === b.warmth;

const findClip = (ed: Editor, id: string): { clip: Clip; track: string } | null => {
  for (const tr of ed.timeline.tracks) {
    const clip = tr.clips.find((c) => c.id === id);
    if (clip) return { clip, track: tr.id };
  }
  return null;
};

/** A clip on any track. */
export function clipMenu(get: () => Editor, id: string): MenuEntry[] {
  const ed = get();
  const hit = findClip(ed, id);
  if (!hit) return [];
  const { clip, track } = hit;
  const main = track === 'v1';
  const sound = track === MUSIC;
  const video = clip.source.kind === 'clip';
  const inside = ed.playhead > clip.start + 0.1 && ed.playhead < clip.start + clip.duration - 0.1;
  const index = main ? ed.clips.findIndex((c) => c.id === id) : -1;
  const act = () => get().actions;
  const grade = clip.grade ?? NEUTRAL;
  const push = clip.zoom ? (clip.zoom.to > clip.zoom.from ? 'in' : 'out') : 'none';
  const touched = Boolean(clip.grade || clip.zoom || clip.fadeIn || clip.fadeOut || (clip.speed && clip.speed !== 1));

  const entries: MenuEntry[] = [
    { label: 'Split at playhead', shortcut: 'S', disabled: !main || !inside, onSelect: () => act().split() },
    { label: 'Trim start to playhead', shortcut: 'Q', disabled: !inside, onSelect: () => act().trimToPlayhead('in') },
    { label: 'Trim end to playhead', shortcut: 'W', disabled: !inside, onSelect: () => act().trimToPlayhead('out') },
    { kind: 'separator' },
    { label: 'Duplicate', shortcut: `${MOD}D`, onSelect: () => act().duplicate(id) },
    { label: 'Copy', shortcut: `${MOD}C`, onSelect: () => act().copy(id) },
    {
      label: 'Cut',
      shortcut: `${MOD}X`,
      onSelect: () => {
        act().copy(id);
        act().remove();
      },
    },
    { label: main ? 'Paste after' : 'Paste at playhead', shortcut: `${MOD}V`, disabled: !ed.canPaste, onSelect: () => act().paste() },
  ];

  if (main) {
    entries.push(
      { kind: 'separator' },
      {
        label: 'Make a shot for this line with AI…',
        disabled: !clip.caption.trim(),
        onSelect: () => window.dispatchEvent(new CustomEvent('studio:shot-for', { detail: id })),
      },
      { label: 'Move earlier', shortcut: 'Alt+←', disabled: index <= 0, onSelect: () => act().move(-1) },
      { label: 'Move later', shortcut: 'Alt+→', disabled: index === ed.clips.length - 1, onSelect: () => act().move(1) },
    );
  }

  if (sound) {
    entries.push(
      { kind: 'separator' },
      {
        kind: 'row',
        label: 'Level',
        options: [0.25, 0.5, 1].map((v) => ({
          label: `${Math.round(v * 100)}%`,
          active: Math.abs((clip.volume ?? 1) - v) < 0.01,
          onSelect: () => act().setVolume(id, v),
        })),
      },
      { label: 'Mute music track', checked: ed.muted.a1, onSelect: () => act().toggleMute('a1') },
    );
  } else {
    entries.push(
      { kind: 'separator' },
      {
        kind: 'row',
        label: 'Look',
        options: LOOKS.map((l) => ({ label: l.label, active: sameGrade(grade, l.grade), onSelect: () => act().setLook(id, l.grade) })),
      },
      {
        kind: 'row',
        label: 'Push',
        options: (['none', 'in', 'out'] as const).map((p) => ({
          label: p === 'none' ? 'None' : p === 'in' ? 'In' : 'Out',
          active: push === p,
          onSelect: () => act().setMotion(id, { zoom: p === 'none' ? null : PUSH[p] }),
        })),
      },
    );
    if (video) {
      entries.push({
        kind: 'row',
        label: 'Speed',
        options: SPEEDS.map((s) => ({ label: `${s}×`, active: (clip.speed ?? 1) === s, onSelect: () => act().setSpeed(id, s) })),
      });
    }
    entries.push(
      { label: 'Fade in', checked: (clip.fadeIn ?? 0) > 0, onSelect: () => act().setMotion(id, { fadeIn: (clip.fadeIn ?? 0) > 0 ? 0 : 0.5 }) },
      { label: 'Fade out', checked: (clip.fadeOut ?? 0) > 0, onSelect: () => act().setMotion(id, { fadeOut: (clip.fadeOut ?? 0) > 0 ? 0 : 0.5 }) },
      { label: 'Reset effects', disabled: !touched, onSelect: () => act().resetEffects(id) },
    );
  }

  entries.push({ kind: 'separator' }, { label: 'Delete', shortcut: 'Del', danger: true, onSelect: () => act().remove() });
  return entries;
}

/** Empty timeline, or the ruler. */
export function timelineMenu(get: () => Editor, zoom: { in: () => void; out: () => void; fit: () => void; canIn: boolean; canOut: boolean }): MenuEntry[] {
  const ed = get();
  const act = () => get().actions;
  return [
    { label: 'Paste at end', shortcut: `${MOD}V`, disabled: !ed.canPaste, onSelect: () => act().paste() },
    { label: 'Split at playhead', shortcut: 'S', disabled: ed.clips.length === 0, onSelect: () => act().split() },
    { label: 'Add text card', shortcut: 'T', onSelect: () => act().addCard() },
    { label: 'Marker at playhead', shortcut: 'M', disabled: ed.total === 0, onSelect: () => act().toggleMarker() },
    { kind: 'separator' },
    { label: 'Zoom in', shortcut: '=', disabled: !zoom.canIn, onSelect: zoom.in },
    { label: 'Zoom out', shortcut: '−', disabled: !zoom.canOut, onSelect: zoom.out },
    { label: 'Fit the reel', shortcut: 'Shift+Z', disabled: !zoom.canOut, onSelect: zoom.fit },
    { kind: 'separator' },
    { label: 'Mute video sound', checked: ed.muted.v1, onSelect: () => act().toggleMute('v1') },
    { label: 'Mute music', checked: ed.muted.a1, onSelect: () => act().toggleMute('a1') },
  ];
}

/** A tile in the media bin. */
export function mediaMenu(get: () => Editor, item: { name: string; kind: string }): MenuEntry[] {
  const act = () => get().actions;
  if (item.kind === 'audio') {
    return [{ label: 'Add to the music track', onSelect: () => act().placeMusic(item.name) }];
  }
  return [
    { label: 'Add to the end of the reel', onSelect: () => act().place(item.name) },
    { label: 'Cut in over the main track at the playhead', onSelect: () => act().placeOverlay(item.name) },
  ];
}

/** The viewer. */
export function viewerMenu(get: () => Editor, frame: { save: () => void; copy: () => void }): MenuEntry[] {
  const ed = get();
  const act = () => get().actions;
  return [
    { label: ed.playing ? 'Pause' : 'Play', shortcut: 'Space', disabled: ed.total === 0, onSelect: () => act().togglePlay() },
    { label: 'Marker at playhead', shortcut: 'M', disabled: ed.total === 0, onSelect: () => act().toggleMarker() },
    { kind: 'separator' },
    { label: 'Save this frame as PNG', shortcut: `${MOD}Shift+S`, disabled: ed.total === 0, onSelect: frame.save },
    { label: 'Copy this frame', disabled: ed.total === 0, onSelect: frame.copy },
  ];
}

