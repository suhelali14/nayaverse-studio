/**
 * The editor's pass: beats found in sound, and the changes proposed from
 * them, without a browser.
 */
import { applyPolish, BEAT_REACH, detectBeats, planPolish } from '../src/lib/polish.js';
import { append, emptyTimeline, validate, type Clip, type Timeline } from '../src/lib/timeline.js';

let pass = 0;
let fail = 0;
const ok = (c: boolean, what: string, extra = '') => {
  if (c) {
    pass += 1;
    console.log(`  ok    ${what}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${what}${extra ? `\n          ${extra}` : ''}`);
  }
};

/** A click track: a decaying 80Hz thump every beat, a little noise between. */
function clicks(bpm: number, seconds: number, rate = 48000, offset = 0): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  const period = 60 / bpm;
  let seed = 7;
  for (let i = 0; i < out.length; i += 1) {
    const t = i / rate;
    const since = (t - offset) % period;
    const local = since < 0 ? since + period : since;
    seed = (seed * 16807) % 2147483647;
    out[i] = Math.sin(2 * Math.PI * 80 * local) * Math.exp(-local * 18) * 0.8 + ((seed / 2147483647) - 0.5) * 0.02;
  }
  return out;
}

console.log('\nbeats');
{
  const b120 = detectBeats(clicks(120, 10), 48000);
  ok(b120.bpm !== null && Math.abs(b120.bpm - 120) <= 3, '120 BPM is heard as 120', String(b120.bpm));
  const off = b120.times.map((t) => Math.abs(t - Math.round(t / 0.5) * 0.5));
  ok(Math.max(...off.slice(0, 15)) < 0.03, 'and its beats sit on the half seconds', off.slice(0, 6).map((x) => x.toFixed(3)).join(' '));
  const b90 = detectBeats(clicks(90, 10), 48000);
  ok(b90.bpm !== null && Math.abs(b90.bpm - 90) <= 3, '90 BPM is heard as 90', String(b90.bpm));
  const shifted = detectBeats(clicks(120, 10, 48000, 0.2), 48000);
  ok(Math.abs((shifted.times[0] ?? 0) % 0.5 - 0.2) < 0.03, 'a track that starts off the beat is found where it is', String(shifted.times[0]));
  const quiet = detectBeats(new Float32Array(48000 * 5), 48000);
  ok(quiet.times.length === 0 && quiet.bpm === null, 'silence has no beat');
}

const photo = (id: string, duration: number, extra: Partial<Clip> = {}): Omit<Clip, 'start'> => ({
  id,
  duration,
  sourceIn: 0,
  caption: id,
  source: { kind: 'photo', path: `${id}.jpg` },
  ...extra,
});
const reel = (...clips: Omit<Clip, 'start'>[]): Timeline => clips.reduce((t, c) => append(t, 'v1', c), emptyTimeline());
const halfSeconds = Array.from({ length: 40 }, (_, i) => i * 0.5);

console.log('\ncutting on the beat');
{
  const t = reel(photo('a', 2.9), photo('b', 3.2), photo('c', 3));
  const plan = planPolish({ timeline: t, beats: halfSeconds, voice: false });
  const beats = plan.find((s) => s.key === 'beats');
  ok(beats !== undefined && beats.changes.length === 2, 'both cuts are offered', JSON.stringify(beats?.changes));
  const done = applyPolish(t, beats!.changes);
  const main = done.tracks[0]!.clips;
  ok(Math.abs(main[1]!.start - 3) < 1e-6, 'the first cut lands on 3.0', String(main[1]!.start));
  ok(Math.abs(main[2]!.start - 6) < 1e-6, 'the second, measured after the first moved, on 6.0', String(main[2]!.start));
  ok(validate(done).length === 0, 'and the reel has no gap or overlap');

  const far = reel(photo('a', 2.5 + BEAT_REACH + 0.05 - 0.5), photo('b', 3));
  // 2.4s: nearest beats 2.0 and 2.5; within reach of 2.5, so it moves.
  ok(planPolish({ timeline: far, beats: [0, 1.9, 3.5], voice: false }).find((s) => s.key === 'beats') === undefined, 'a beat further than the reach is left alone');
  const short = reel(photo('a', 1.05), photo('b', 3));
  ok(planPolish({ timeline: short, beats: [0, 0.5, 4], voice: false }).find((s) => s.key === 'beats') === undefined, 'no shot is cut below a second to make a beat');
}

console.log('\nthe rest of the pass');
{
  const t = reel(photo('a', 3, { fadeIn: 0.5 }), photo('b', 3.5), photo('c', 3), photo('d', 3));
  const plan = planPolish({ timeline: t, beats: [], voice: false });
  const keys = plan.map((s) => s.key);
  ok(keys.includes('hook-push'), 'a push in on the opening shot');
  ok(keys.includes('hook-fade'), 'and no fade from black before it');
  const stills = plan.find((s) => s.key === 'stills')!;
  ok(stills.changes.length === 3, 'a slow push on each still held long enough', String(stills.changes.length));
  const dirs = stills.changes.map((c) => (c.kind === 'zoom' && c.zoom ? (c.zoom.to > c.zoom.from ? 'in' : 'out') : '?'));
  ok(dirs.join(',') === 'in,out,in', 'alternating in and out, so it does not drift one way', dirs.join(','));
  ok(keys.includes('end-fade'), 'a fade out on the last shot');
  const pushed = reel(photo('a', 3, { zoom: { from: 1, to: 1.2 } }), photo('b', 3));
  ok(!planPolish({ timeline: pushed, beats: [], voice: false }).some((s) => s.key === 'hook-push'), 'a hook that already moves is left alone');

  const emph = planPolish({ timeline: t, beats: [], voice: false, emphasis: [{ id: 'c', reason: 'The turn of the story.' }] });
  ok(emph.some((s) => s.key === 'emphasis-c' && s.reason === 'The turn of the story.'), 'emphasis carries the reason it was asked for');
  ok(!(emph.find((s) => s.key === 'stills')?.changes.some((c) => c.id === 'c') ?? false), 'and that shot is not also given a slow push');

  const grade = { exposure: 1.04, contrast: 1.06, saturation: 1.1, warmth: 0.5 };
  const look = planPolish({ timeline: t, beats: [], voice: false, look: { label: 'Warm', grade, reason: 'Morning light.' } }).find((s) => s.key === 'look')!;
  ok(look.changes.length === 4, 'one look offered across every shot');
  const graded = applyPolish(t, look.changes);
  ok(graded.tracks[0]!.clips.every((c) => c.grade?.warmth === 0.5), 'and applied to all of them');
}

console.log('\nmusic level');
{
  let t = reel(photo('a', 3), photo('b', 3));
  t = { ...t, tracks: [...t.tracks, { id: 'a1', kind: 'audio', clips: [{ id: 'm', start: 0, duration: 6, sourceIn: 0, caption: '', source: { kind: 'clip', path: 'beat.mp3', from: 0, to: 6 }, volume: 0.6 }] }] };
  const under = planPolish({ timeline: t, beats: [], voice: true }).find((s) => s.key === 'music')!;
  ok(under.changes[0]?.kind === 'volume' && under.changes[0].volume === 0.25, 'under a voice, music goes to 25%');
  const up = planPolish({ timeline: t, beats: [], voice: false }).find((s) => s.key === 'music')!;
  ok(up.changes[0]?.kind === 'volume' && up.changes[0].volume === 0.8, 'with no voice it carries the reel at 80%');
  const done = applyPolish(t, under.changes);
  ok(done.tracks.find((x) => x.id === 'a1')!.clips[0]!.volume === 0.25, 'and the level is applied');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
