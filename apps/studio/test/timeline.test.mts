/**
 * The timeline document, exercised without a browser.
 *
 * These are the editor's specification. When a UI exists, the UI is correct
 * exactly when it produces the same documents these cases describe.
 */
import {
  append,
  compact,
  duration,
  emptyTimeline,
  fromPost,
  insertAfter,
  rippleDelete,
  reorder,
  splitAt,
  toOTIO,
  toShots,
  trim,
  validate,
  type Clip,
  type Timeline,
} from '../src/lib/timeline.js';
import type { Post } from '../src/lib/store.js';

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
const eq = (a: number, b: number, what: string) =>
  ok(Math.abs(a - b) < 1e-6, what, `expected ${b}, got ${a}`);

const clip = (id: string, dur: number, sourceIn = 0): Omit<Clip, 'start'> => ({
  id,
  duration: dur,
  sourceIn,
  caption: id.toUpperCase(),
  source: { kind: 'clip', path: 'take.mp4', from: sourceIn, to: sourceIn + dur },
});

const build = (): Timeline => {
  let t = emptyTimeline();
  t = append(t, 'v1', clip('a', 4, 0));
  t = append(t, 'v1', clip('b', 3, 10));
  t = append(t, 'v1', clip('c', 5, 20));
  return t;
};
const clips = (t: Timeline) => t.tracks[0]!.clips;
const byId = (t: Timeline, id: string) => clips(t).find((c) => c.id === id);

console.log('\nlaying clips down');
{
  const t = build();
  eq(clips(t).length, 3, 'three clips');
  eq(byId(t, 'a')!.start, 0, 'first starts at zero');
  eq(byId(t, 'b')!.start, 4, 'second abuts the first');
  eq(byId(t, 'c')!.start, 7, 'third abuts the second');
  eq(duration(t), 12, 'total duration');
  ok(validate(t).length === 0, 'no problems');
}

console.log('\nsplitting');
{
  const t = splitAt(build(), 'v1', 6);
  eq(clips(t).length, 4, 'one more clip than before');
  const first = byId(t, 'b')!;
  const second = byId(t, 'b-b')!;
  eq(first.duration, 2, 'first half is 2s');
  eq(second.duration, 1, 'second half is 1s');
  eq(second.start, 6, 'second half starts at the cut');
  // The property that matters: the back half must not rewind the footage.
  eq(second.sourceIn, 12, 'second half advances into the source');
  eq(duration(t), 12, 'splitting changes nothing about total length');
  ok(validate(t).length === 0, 'still valid');
}
{
  const t = build();
  ok(clips(splitAt(t, 'v1', 4)).length === 3, 'a split exactly on a boundary is a no-op');
  ok(clips(splitAt(t, 'v1', 0)).length === 3, 'a split at zero is a no-op');
  ok(clips(splitAt(t, 'v1', 12)).length === 3, 'a split at the very end is a no-op');
  ok(clips(splitAt(t, 'v1', 99)).length === 3, 'a split past the end is a no-op');
}

console.log('\ntrimming the out-point');
{
  let t = trim(build(), 'v1', 'b', 'out', 2);
  eq(byId(t, 'b')!.duration, 5, 'lengthened by 2s');
  t = trim(build(), 'v1', 'b', 'out', -10);
  ok(byId(t, 'b')!.duration > 0, 'cannot be trimmed to zero or below');
  // A clip cannot run past the end of the footage it points at.
  t = trim(build(), 'v1', 'b', 'out', 100, 14);
  eq(byId(t, 'b')!.duration, 4, 'clamped to what is left of a 14s source from 10s in');
}

console.log('\ntrimming the in-point');
{
  const t = trim(build(), 'v1', 'b', 'in', 1);
  const b = byId(t, 'b')!;
  eq(b.start, 5, 'start moves right');
  eq(b.duration, 2, 'and it gets shorter');
  // Without this the frame under the playhead jumps, which every editor
  // gets right and whose absence is instantly visible.
  eq(b.sourceIn, 11, 'the source advances by the same amount');

  const back = trim(build(), 'v1', 'a', 'in', -5);
  eq(byId(back, 'a')!.sourceIn, 0, 'cannot pull back before the source begins');
  const inverted = trim(build(), 'v1', 'b', 'in', 99);
  ok(byId(inverted, 'b')!.duration > 0, 'cannot be inverted by over-dragging');
}

console.log('\nripple delete closes the hole');
{
  const t = rippleDelete(build(), 'v1', 'b');
  eq(clips(t).length, 2, 'one fewer clip');
  eq(byId(t, 'c')!.start, 4, 'the survivor slid left');
  eq(duration(t), 9, 'total shortened by exactly the deleted clip');
  ok(validate(t).length === 0, 'no gap and no overlap');
}

console.log('\nreordering');
{
  const t = reorder(build(), 'v1', 'c', 0);
  const order = clips(t).map((c) => c.id);
  ok(order.join(',') === 'c,a,b', 'c moved to the front', order.join(','));
  eq(byId(t, 'c')!.start, 0, 'and starts at zero');
  eq(byId(t, 'a')!.start, 5, 'a follows it');
  eq(duration(t), 12, 'length is unchanged');
  ok(validate(t).length === 0, 'no gaps introduced');
  // Durations must travel with their clips, not with their positions.
  eq(byId(t, 'b')!.duration, 3, 'b kept its own duration');
}

console.log('\ninserting after (duplicate, paste)');
{
  const t = insertAfter(build(), 'v1', 'a', clip('a2', 4, 0));
  const order = clips(t).map((c) => c.id).join(',');
  ok(order === 'a,a2,b,c', 'the copy lands right after its original', order);
  eq(byId(t, 'a2')!.start, 4, 'starting where the original ends');
  eq(byId(t, 'b')!.start, 8, 'everything after moves along by its length');
  eq(duration(t), 16, 'the reel grows by exactly the copy');
  ok(validate(t).length === 0, 'no gap and no overlap');
  const first = insertAfter(build(), 'v1', null, clip('z', 2));
  ok(clips(first)[0]!.id === 'z' && byId(first, 'a')!.start === 2, 'null puts it first');
  let threw = false;
  try {
    insertAfter(build(), 'v1', 'nope', clip('x', 1));
  } catch {
    threw = true;
  }
  ok(threw, 'an unknown anchor is refused, not silently appended');
  threw = false;
  try {
    insertAfter(build(), 'v1', 'a', clip('b', 1));
  } catch {
    threw = true;
  }
  ok(threw, 'a duplicate id is refused');
}

console.log('\nvalidate actually catches things');
{
  const broken = build();
  broken.tracks[0]!.clips[1]!.start = 1; // now overlapping a
  ok(validate(broken).some((p) => p.what.includes('overlaps')), 'overlap caught');

  const neg = build();
  neg.tracks[0]!.clips[0]!.duration = 0;
  ok(validate(neg).some((p) => p.what.includes('zero or negative')), 'zero duration caught');

  const before = build();
  before.tracks[0]!.clips[0]!.start = -2;
  ok(validate(before).some((p) => p.what.includes('before zero')), 'negative start caught');
}

console.log('\ncompacting removes gaps');
{
  const gapped = build();
  gapped.tracks[0]!.clips[2]!.start = 40;
  eq(duration(gapped), 45, 'the gap is real before compacting');
  const t = compact(gapped, 'v1');
  eq(duration(t), 12, 'and gone after');
  ok(validate(t).length === 0, 'valid afterwards');
}

console.log('\na drafted post round-trips');
{
  const post: Post = {
    id: 'p1',
    channel: 'main',
    language: 'en',
    status: 'draft',
    premise: 'p',
    forWhom: 'f',
    shots: [
      { seconds: 4, caption: 'ONE', source: { kind: 'clip', path: 'take.mp4', from: 2, to: 6 } },
      { seconds: 3, caption: 'TWO', source: { kind: 'solid', label: 'Card' } },
      { seconds: 5, caption: 'THREE', source: { kind: 'photo', path: 'me.jpg' } },
    ],
    caption: 'c',
    createdAt: new Date().toISOString(),
  };
  const t = fromPost(post);
  eq(duration(t), 12, 'timeline length matches the post');
  eq(byId(t, 'c1')!.sourceIn, 2, 'a clip keeps its in-point');

  const back = toShots(t);
  ok(back.length === 3, 'three shots come back');
  ok(
    JSON.stringify(back[1]!.source) === JSON.stringify(post.shots[1]!.source),
    'a title card survives untouched',
  );
  eq(back[0]!.seconds, 4, 'durations survive');

  // The real test: edit it, then render what comes out.
  const edited = toShots(rippleDelete(splitAt(t, 'v1', 2), 'v1', 'c1'));
  eq(edited.length, 3, 'split then delete the first half leaves three');
  const first = edited[0]!.source as { from: number };
  eq(first.from, 4, 'and the survivor plays from 4s into the source, not 0');
}

console.log('\nOTIO export');
{
  const otio = toOTIO(build()) as {
    OTIO_SCHEMA: string;
    tracks: { children: { children: { source_range: { duration: { value: number } } }[] }[] };
  };
  ok(otio.OTIO_SCHEMA === 'Timeline.1', 'declares the schema');
  const first = otio.tracks.children[0]!.children;
  ok(first.length === 3, 'three clips exported');
  eq(first[0]!.source_range.duration.value, 120, '4s at 30fps is 120 frames');
  ok(JSON.stringify(otio).length > 0, 'serialises to JSON');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
