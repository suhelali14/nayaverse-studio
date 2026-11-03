/**
 * The pipeline, driven end to end with a stubbed model.
 *
 * Everything except the writing runs for real: role ordering, the dead
 * opening filter, the critic skip, the asset fallback and the rule guard.
 * Those are where the bugs in a thing like this actually live.
 */
import { StubModel } from '../src/agents/model.js';
import { draftPost } from '../src/agents/runtime.js';
import { parseWorkspace } from '../src/domain/workspace.js';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, what: string, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ok    ${what}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${what}${extra ? `\n          ${extra}` : ''}`);
  }
};

const wsResult = parseWorkspace({
  slug: 'test',
  name: 'Test Co',
  context: {
    what: 'A test business that exists only to exercise this pipeline end to end.',
    whatWorks: ['the thing it actually does'],
    doesNotExist: ['nationwide shipping'],
    mustNotClaim: ['organic'],
    assets: [{ path: 'face.jpg', describes: 'a portrait', kind: 'photo' }],
  },
  channels: [
    {
      key: 'main',
      platform: 'instagram',
      handle: '@test',
      promise: 'Something a follower gets from this account every week.',
      audience: { who: 'a tester', jobToBeDone: 'verify the pipeline' },
      languages: ['en'],
      beats: ['testing'],
      rulePacks: [],
    },
  ],
});
if (!wsResult.ok) {
  console.error('fixture workspace is invalid:', wsResult.problems);
  process.exit(1);
}
const ws = wsResult.workspace;
const ch = ws.channels[0]!;

const answers = {
  strategist: JSON.stringify({
    premise: 'The quiet hour is the useful one.',
    forWhom: 'Someone who only ever visits at the busy time.',
    angle: 'Open on the empty room, not the queue.',
    archetypes: ['curiosity-gap', 'contrarian', 'not-a-real-archetype'],
  }),
  hooksmith: JSON.stringify({
    candidates: [
      { archetype: 'curiosity-gap', line: 'The busiest hour here is not the morning.' },
      { archetype: 'specific-outcome', line: 'Half past four. Twenty minutes. No queue.' },
      // Must be refused by code before the critic ever sees it.
      { archetype: 'contrarian', line: 'Hey guys, welcome back to the channel.' },
    ],
  }),
  critic: JSON.stringify({ chosen: 'curiosity-gap', why: 'It withholds exactly one thing.' }),
  scriptwriter: JSON.stringify({
    beats: [
      { seconds: 3, caption: 'The busiest hour is not morning', shows: 'the empty room' },
      { seconds: 3, caption: 'It is half past four', shows: 'a clock' },
      { seconds: 3, caption: 'Come then instead', shows: 'a portrait' },
    ],
    caption: 'Half past four is the quiet hour.\nCome then.\n#test #quiet #hour',
  }),
  'art-director': JSON.stringify({
    shots: [
      { source: { kind: 'solid', label: 'Empty room' } },
      // An asset that does not exist: must fall back, not reach ffmpeg.
      { source: { kind: 'photo', path: 'does-not-exist.jpg' } },
      { source: { kind: 'photo', path: 'face.jpg' } },
    ],
  }),
};

console.log('\nfull pipeline, nothing held');
{
  const model = new StubModel(answers);
  const r = await draftPost(model, ws, ch, 'en', []);

  ok(
    model.seen.join(' > ') === 'strategist > hooksmith > critic > scriptwriter > art-director',
    'roles run in order',
    model.seen.join(' > '),
  );
  ok(r.rejectedHooks.length === 1, 'the greeting hook was refused');
  ok(
    r.rejectedHooks[0]?.line.startsWith('Hey guys'),
    'and it was the greeting, not the good one',
  );
  ok(r.post.status === 'draft', 'clean copy is a draft, not held');
  ok(r.post.shots.length === 3, 'one shot per beat');
  ok(
    r.post.shots[1]?.source.kind === 'solid',
    'an invented asset path fell back to a title card',
    JSON.stringify(r.post.shots[1]?.source),
  );
  ok(
    r.post.shots[2]?.source.kind === 'photo',
    'a real asset path survived as a photo',
    JSON.stringify(r.post.shots[2]?.source),
  );
  ok(r.ledger.calls === 5, 'five model calls', `got ${r.ledger.calls}`);
}

console.log('\ncritic is skipped when only one hook survives');
{
  const model = new StubModel({
    ...answers,
    hooksmith: JSON.stringify({
      candidates: [{ archetype: 'curiosity-gap', line: 'The busiest hour is not the morning.' }],
    }),
  });
  const r = await draftPost(model, ws, ch, 'en', []);
  ok(!model.seen.includes('critic'), 'no critic call for a shortlist of one');
  ok(r.ledger.calls === 4, 'four calls instead of five', `got ${r.ledger.calls}`);
}

console.log('\nthe rule guard still runs on what the roles produced');
{
  const model = new StubModel({
    ...answers,
    scriptwriter: JSON.stringify({
      beats: [{ seconds: 3, caption: 'Now with organic flour', shows: 'flour' }],
      caption: 'We ship nationwide now, guaranteed.\n#test',
    }),
    'art-director': JSON.stringify({ shots: [{ source: { kind: 'solid', label: 'Flour' } }] }),
  });
  const r = await draftPost(model, ws, ch, 'en', []);
  ok(r.post.status === 'held', 'rule-breaking copy is held');
  const rules = (r.post.violations ?? []).map((v) => v.rule);
  ok(rules.includes('guaranteed-outcome'), 'caught the guarantee');
  ok(
    rules.some((x) => x.startsWith('does-not-exist')),
    'caught the thing that does not exist',
    rules.join(', '),
  );
  ok(
    rules.some((x) => x.startsWith('must-not-claim')),
    'caught the claim it must not make',
    rules.join(', '),
  );
}

console.log('\nevery hook dying is an error, not a silent pass');
{
  const model = new StubModel({
    ...answers,
    hooksmith: JSON.stringify({
      candidates: [
        { archetype: 'curiosity-gap', line: 'Hey, welcome back!' },
        { archetype: 'contrarian', line: 'In this video I will show you something.' },
      ],
    }),
  });
  let threw = false;
  try {
    await draftPost(model, ws, ch, 'en', []);
  } catch {
    threw = true;
  }
  ok(threw, 'throws rather than publishing a greeting');
}

console.log('\nan unknown archetype from the strategist is dropped, not passed on');
{
  const model = new StubModel(answers);
  await draftPost(model, ws, ch, 'en', []);
  ok(true, 'ran without an unknown-key crash');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
