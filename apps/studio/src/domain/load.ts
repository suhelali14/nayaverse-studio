import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseWorkspace, type Workspace } from './workspace.js';

/**
 * Workspaces, as folders on disk.
 *
 *   workspaces/<slug>/workspace.json   what the business is
 *   workspaces/<slug>/assets/          the shots it can cut from
 *   workspaces/<slug>/content/         drafts and renders
 *
 * Files rather than a database, for now and on purpose. The thing a user of
 * this platform most needs to do is read their own context and correct it —
 * a wrong line in `whatWorks` poisons every post until someone fixes it —
 * and a JSON file they can open beats any admin screen until there is a
 * second user who is not in the room.
 */

export const workspacesRoot = (): string => resolve(process.cwd(), 'workspaces');

export const workspaceDir = (slug: string): string => join(workspacesRoot(), slug);

export const listSlugs = (): string[] => {
  const root = workspacesRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'workspace.json')))
    .map((e) => e.name)
    .sort();
};

export interface Loaded {
  workspace: Workspace;
  dir: string;
}

/**
 * One workspace, or a readable explanation of why not.
 *
 * Throws rather than returning a result type because every caller is a CLI
 * command that cannot proceed without it, and the message is written for the
 * person who filled the file in.
 */
export function loadWorkspace(slug: string): Loaded {
  const dir = workspaceDir(slug);
  const file = join(dir, 'workspace.json');
  if (!existsSync(file)) {
    const known = listSlugs();
    throw new Error(
      `No workspace at workspaces/${slug}/workspace.json.\n` +
        (known.length
          ? `Known workspaces: ${known.join(', ')}`
          : 'There are none yet. Run: npm run studio -- init <slug>'),
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(
      `workspaces/${slug}/workspace.json is not valid JSON: ${e instanceof Error ? e.message : e}`,
    );
  }

  const result = parseWorkspace(raw);
  if (!result.ok) {
    throw new Error(
      `workspaces/${slug}/workspace.json does not describe a workspace:\n` +
        result.problems.map((p) => `  ${p}`).join('\n'),
    );
  }
  if (result.workspace.slug !== slug) {
    // Caught early because every path downstream is built from the slug,
    // and a mismatch writes one workspace's drafts into another's folder.
    throw new Error(
      `The folder is "${slug}" but the file says slug "${result.workspace.slug}". Make them match.`,
    );
  }
  return { workspace: result.workspace, dir };
}

/**
 * A starting workspace, with every field present and obviously unfinished.
 *
 * Written with placeholders rather than left empty: a user staring at an
 * empty schema does not know what `mustNotClaim` is for, and a user looking
 * at a filled-in example does. The placeholders are deliberately absurd so
 * nobody ships them by accident.
 */
export function initWorkspace(slug: string, name: string): string {
  const dir = workspaceDir(slug);
  if (existsSync(join(dir, 'workspace.json'))) {
    throw new Error(`workspaces/${slug}/workspace.json already exists. Edit it rather than re-init.`);
  }
  mkdirSync(join(dir, 'assets'), { recursive: true });
  mkdirSync(join(dir, 'content'), { recursive: true });

  const starter = {
    slug,
    name,
    autoPublish: false,
    context: {
      what: `REPLACE THIS. Two or three plain sentences about ${name}: what it is, who pays for it, and what they get. Not a tagline.`,
      whatWorks: [
        'REPLACE THIS with something that genuinely works today',
        'and another, as specific as you can bear to be',
      ],
      doesNotExist: [
        'REPLACE THIS with something people might assume you have, and you do not',
      ],
      mustNotClaim: [
        'REPLACE THIS with a claim you must never make',
      ],
      voice: 'plain, specific, no hype',
      assets: [],
    },
    channels: [
      {
        key: 'main',
        platform: 'instagram',
        handle: '@your_handle',
        promise: 'REPLACE THIS: one sentence on what a follower gets.',
        audience: {
          who: 'REPLACE THIS: the specific person, e.g. a receptionist at a two-doctor clinic',
          region: 'India',
          jobToBeDone: 'REPLACE THIS: what they are trying to get done',
        },
        languages: ['en'],
        beats: ['REPLACE THIS with a subject this account covers'],
        cadencePerWeek: 3,
        rulePacks: [],
        active: true,
      },
    ],
  };

  const file = join(dir, 'workspace.json');
  writeFileSync(file, `${JSON.stringify(starter, null, 2)}\n`, 'utf8');
  return file;
}
