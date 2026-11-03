#!/usr/bin/env node
/**
 * The platform, from the terminal.
 *
 *   studio init <slug> "Name"     start a workspace
 *   studio doctor [slug]          what is configured, what is missing
 *   studio packs                  the rule packs a channel can opt into
 *   studio draft <slug>           write the next post for each channel
 *   studio review <slug>          read the queue, approve or reject
 *   studio publish <slug>         send everything approved
 *
 * The split is the design. `draft` never publishes, `publish` never writes,
 * and `review` is a person. A bad idea costs a draft rather than a post, and
 * the thing that speaks in public is a separate, deliberate act.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { env, instagramFor } from './config/env.js';
import { channelOf, type Channel, type Workspace } from './domain/workspace.js';
import { initWorkspace, listSlugs, loadWorkspace } from './domain/load.js';
import { check, ruleCount, unknownPacks } from './lib/guard.js';
import { draftPost } from './agents/runtime.js';
import { ClaudeModel } from './agents/model.js';
import { ffmpegVersion, renderPost } from './lib/render.js';
import { publishReel, quotaFor } from './lib/instagram.js';
import { Store, type Post } from './lib/store.js';
import { optionalPacks } from './packs/rules.js';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'help';
const positional = argv.slice(1).filter((a) => !a.startsWith('--'));
const flag = (n: string) => argv.includes(`--${n}`);
const value = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1]! : undefined;
};

const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

const requireSlug = (): string =>
  positional[0] ??
  (listSlugs().length === 1
    ? listSlugs()[0]!
    : die(
        listSlugs().length === 0
          ? 'No workspaces yet. Run: studio init <slug> "Name"'
          : `Which workspace? ${listSlugs().join(', ')}`,
      ));

// ---------------------------------------------------------------------------

function cmdInit(): void {
  const slug = positional[0] ?? die('studio init <slug> "Name"');
  const name = positional[1] ?? slug;
  if (!/^[a-z0-9-]+$/.test(slug)) die('A slug is lowercase letters, digits and dashes.');
  const file = initWorkspace(slug, name);
  console.log(`Created ${file}\n`);
  console.log('Now fill it in. The fields that matter most, in order:');
  console.log('  context.whatWorks     specifics are what make a post credible');
  console.log('  context.doesNotExist  stops the automation promising what you lack');
  console.log('  context.mustNotClaim  compiled into a check, not just a request');
  console.log('  channels[].audience   a named person, not a segment');
  console.log(`\nThen: studio doctor ${slug}`);
}

function cmdPacks(): void {
  console.log('Rule packs. "always" runs for everyone; the rest are opted into');
  console.log('per channel, via channels[].rulePacks in workspace.json.\n');
  for (const p of optionalPacks()) {
    console.log(`  ${p.key.padEnd(12)} ${p.label}`);
    console.log(`  ${''.padEnd(12)} ${p.forWhom}`);
    console.log(`  ${''.padEnd(12)} ${p.rules.length} rule(s): ${p.rules.map((r) => r.id).join(', ')}\n`);
  }
}

async function cmdDoctor(): Promise<void> {
  const slugs = positional[0] ? [positional[0]] : listSlugs();
  console.log('studio\n');
  const ff = ffmpegVersion();
  console.log(`  ffmpeg        ${ff ? ff.slice(0, 52) : 'MISSING — run npm install'}`);
  console.log(`  model key     ${env.ANTHROPIC_API_KEY ? 'set' : 'MISSING — drafting cannot run'}`);
  console.log(`  model         ${env.STUDIO_MODEL}`);
  console.log(`  workspaces    ${slugs.length ? slugs.join(', ') : 'none — run studio init'}`);

  for (const slug of slugs) {
    let w: Workspace;
    try {
      w = loadWorkspace(slug).workspace;
    } catch (e) {
      console.log(`\n  ${slug}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const store = new Store(slug);
    console.log(`\n  ${w.name} (${slug})`);
    console.log(`    autopublish ${w.autoPublish ? 'ON — nobody reviews' : 'off (a person approves)'}`);
    console.log(`    assets      ${w.context.assets.length}${w.context.assets.length === 0 ? ' — every shot will be a title card' : ''}`);

    const placeholders = [
      ...(w.context.what.includes('REPLACE THIS') ? ['context.what'] : []),
      ...(w.context.whatWorks.some((x) => x.includes('REPLACE THIS')) ? ['context.whatWorks'] : []),
      ...(w.channels.some((c) => c.audience.who.includes('REPLACE THIS')) ? ['channels[].audience.who'] : []),
    ];
    if (placeholders.length) {
      console.log(`    UNFILLED    ${placeholders.join(', ')} — drafts will be generic`);
    }

    for (const c of w.channels) {
      const creds = instagramFor(slug, c.key);
      let quota = '';
      if (creds && c.platform === 'instagram') {
        try {
          const q = await quotaFor(slug, c.key);
          if (q) quota = `, ${q.used} posted in 24h`;
        } catch (e) {
          quota = `, quota unreadable (${e instanceof Error ? e.message.slice(0, 48) : 'error'})`;
        }
      }
      const unknown = unknownPacks(c);
      console.log(
        `    ${c.key.padEnd(10)} ${c.platform.padEnd(10)} ${c.handle.padEnd(20)} ` +
          `${ruleCount(c, w.context)} rules  ${creds ? `connected${quota}` : 'no credentials'}` +
          `${c.active ? '' : '  [paused]'}`,
      );
      if (unknown.length) console.log(`    ${''.padEnd(10)} unknown rule pack(s): ${unknown.join(', ')} — run studio packs`);
    }

    const counts = (['draft', 'held', 'approved', 'published', 'rejected'] as const)
      .map((s) => `${store.byStatus(s).length} ${s}`)
      .join(' · ');
    console.log(`    queue       ${counts}`);
  }

  if (!env.ANTHROPIC_API_KEY || !ff) {
    console.log('\n  Not ready. Fix the MISSING lines.');
    process.exit(1);
  }
}

async function cmdDraft(): Promise<void> {
  const slug = requireSlug();
  const { workspace: w, dir } = loadWorkspace(slug);
  const store = new Store(slug);
  const only = value('channel');
  const render = !flag('no-render');
  const verbose = flag('trace');

  const targets = only ? [channelOf(w, only)] : w.channels.filter((c) => c.active);
  if (targets.length === 0) return void console.log('Every channel is paused.');

  const model = new ClaudeModel();
  console.log(`${w.name}: drafting for ${targets.length} channel(s) on ${model.name}.\n`);
  let drafted = 0;
  let held = 0;
  let spent = 0;

  for (const c of targets) {
    // One language per run, rotating by day. Three channels times three
    // languages every day is nine posts, which is more than any account
    // should publish and more than a person will review.
    const lang = c.languages[new Date().getDate() % c.languages.length]!;
    console.log(`  ${c.key} (${lang})`);

    try {
      const r = await draftPost(model, w, c, lang, store.recentPremises(c.key));
      spent += r.ledger.usd(env.STUDIO_PRICE_IN_PER_M, env.STUDIO_PRICE_OUT_PER_M);

      // The trace is how a bad post is diagnosed later: which role chose
      // what. Printed on --trace rather than always, because six lines per
      // channel buries the one line that matters on a normal run.
      if (verbose) {
        for (const t of r.trace) console.log(`      ${t.role.padEnd(13)} ${t.detail}`);
        for (const h of r.rejectedHooks) console.log(`      refused      "${h.line}" — ${h.why}`);
      }

      const post = r.post;
      if (post.violations?.length) {
        held += 1;
        console.log(`    held — ${post.violations.map((v) => `${v.pack}/${v.rule}`).join(', ')}`);
      } else if (render) {
        try {
          const out = renderPost(post, join(dir, 'assets'), store.rendersDir(), w.theme);
          post.videoPath = out.path;
          drafted += 1;
          console.log(`    drafted, ${out.seconds}s`);
          for (const warn of out.warnings) console.log(`      warning: ${warn}`);
        } catch (e) {
          // The script survives a render failure: re-rendering is free,
          // re-drafting costs five calls and loses the idea.
          drafted += 1;
          console.log(`    drafted, NOT rendered — ${e instanceof Error ? e.message.split('\n')[0] : e}`);
        }
      } else {
        drafted += 1;
        console.log('    drafted, render skipped');
      }

      store.save(post);
    } catch (e) {
      console.log(`    failed — ${e instanceof Error ? e.message.split('\n')[0] : e}`);
    }
  }

  console.log(`\n${drafted} drafted, ${held} held.  about $${spent.toFixed(5)} of model time.`);
  if (drafted + held > 0) console.log(`Next: studio review ${slug}`);
}

function cmdReview(): void {
  const slug = requireSlug();
  const { workspace: w } = loadWorkspace(slug);
  const store = new Store(slug);
  const pending = [...store.byStatus('held'), ...store.byStatus('draft')];

  if (pending.length === 0) return void console.log(`Nothing waiting. Run: studio draft ${slug}`);

  const id = value('id');
  if (!id) {
    console.log(`${w.name}: ${pending.length} waiting\n`);
    for (const post of pending) {
      const c = w.channels.find((x) => x.key === post.channel);
      console.log(`  ${post.id}`);
      console.log(`    ${c?.handle ?? post.channel} · ${post.language} · ${post.status}${post.videoPath ? ' · rendered' : ' · no video'}`);
      console.log(`    ${post.premise}`);
      console.log(`    for: ${post.forWhom}`);
      for (const v of post.violations ?? []) {
        console.log(`    HELD [${v.pack}/${v.rule}] "${v.matched}"`);
        console.log(`         ${v.why}`);
      }
      console.log(`    caption: ${post.caption.replace(/\n/g, ' / ').slice(0, 110)}`);
      if (post.videoPath) console.log(`    video: ${post.videoPath}`);
      console.log('');
    }
    console.log(`Then: studio review ${slug} --id <id> --approve`);
    console.log(`  or: studio review ${slug} --id <id> --reject --note "why"`);
    return;
  }

  const post = pending.find((p) => p.id === id) ?? die(`No pending post "${id}".`);

  if (flag('approve')) {
    // A held post can still be approved. The rules are a floor, not a veto,
    // and a false positive must not be unfixable.
    for (const v of post.violations ?? []) {
      console.log(`Approving despite [${v.pack}/${v.rule}] "${v.matched}"`);
    }
    post.status = 'approved';
    post.decidedAt = new Date().toISOString();
    store.save(post);
    console.log(`Approved. Next: studio publish ${slug}`);
  } else if (flag('reject')) {
    post.status = 'rejected';
    post.decidedAt = new Date().toISOString();
    const note = value('note');
    if (note) post.note = note;
    store.save(post);
    console.log(`Rejected.${note ? ' Drafting will avoid this shape.' : ''}`);
  } else {
    die('Pass --approve or --reject.');
  }
}

async function cmdPublish(): Promise<void> {
  const slug = requireSlug();
  const { workspace: w } = loadWorkspace(slug);
  const store = new Store(slug);
  const ready = store.byStatus('approved');
  if (ready.length === 0) return void console.log(`Nothing approved. Run: studio review ${slug}`);

  const dry = !flag('live');
  console.log(`${ready.length} approved.${dry ? ' DRY RUN — pass --live to post.' : ''}\n`);

  for (const post of ready) {
    let c: Channel;
    try {
      c = channelOf(w, post.channel);
    } catch {
      console.log(`  ${post.id}: channel "${post.channel}" no longer exists in this workspace`);
      continue;
    }
    process.stdout.write(`  ${post.id} → ${c.handle} … `);

    if (!post.videoPath || !existsSync(post.videoPath)) {
      console.log('no video on disk');
      continue;
    }
    if (c.platform !== 'instagram') {
      console.log(`${c.platform} publishing is not implemented yet`);
      continue;
    }
    if (!instagramFor(slug, c.key)) {
      console.log('no credentials');
      continue;
    }
    if (dry) {
      console.log('would publish');
      continue;
    }
    try {
      const { instagramId } = await publishReel(slug, c.key, post);
      post.status = 'published';
      post.instagramId = instagramId;
      post.decidedAt = new Date().toISOString();
      store.save(post);
      console.log(`published as ${instagramId}`);
    } catch (e) {
      console.log(`failed — ${e instanceof Error ? e.message : e}`);
    }
  }
}

// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  switch (cmd) {
    case 'init': return cmdInit();
    case 'packs': return cmdPacks();
    case 'doctor': return cmdDoctor();
    case 'draft': return cmdDraft();
    case 'review': return cmdReview();
    case 'publish': return cmdPublish();
    default:
      console.log('studio <init|doctor|packs|draft|review|publish> [workspace]');
      console.log(`  workspaces: ${listSlugs().join(', ') || 'none yet'}`);
      process.exit(cmd === 'help' ? 0 : 1);
  }
};

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
