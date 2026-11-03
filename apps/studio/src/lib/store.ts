import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceDir } from '../domain/load.js';
import type { Violation } from './guard.js';

/**
 * One workspace's queue, as files on disk.
 *
 * A JSON file per post, in a folder per day, under that workspace. Not a
 * database, deliberately: the thing a user most needs to do with a draft is
 * read it, correct a word, and approve it, and a file they can open beats
 * any screen until there is a second user who is not in the room.
 *
 * Scoped per workspace rather than global, because two tenants' drafts
 * sharing a folder is the kind of bug that is discovered by one of them
 * reading the other's post.
 */

export type PostStatus =
  /** Written, nobody has looked. */
  | 'draft'
  /** A rule fired. Needs a person, not a retry. */
  | 'held'
  /** A person said yes. */
  | 'approved'
  /** Out, with the id the platform returned. */
  | 'published'
  /** A person said no. Kept, so drafting does not propose it again. */
  | 'rejected';

export interface Shot {
  /** Seconds on screen. */
  readonly seconds: number;
  /** The words burnt onto it. One short line, two at most. */
  readonly caption: string;
  /**
   * What to show. Never left to chance at render time: a shot with neither
   * an asset nor a label is a hole in the middle of a reel.
   */
  readonly source:
    /** A screenshot or a product capture. Fitted inside, never cropped. */
    | { kind: 'asset'; path: string }
    /** A photograph. Fills the frame, and moves, because a still does not. */
    | { kind: 'photo'; path: string }
    /**
     * A segment of the creator's own footage, with their voice kept.
     *
     * The one source kind that carries audio. Everything else in a reel is
     * silent and gets a silent track so the pieces concatenate; a clip is
     * the reason the track exists at all.
     */
    | { kind: 'clip'; path: string; from: number; to: number }
    | { kind: 'solid'; label: string };
}

export interface Post {
  readonly id: string;
  readonly channel: string;
  readonly language: string;
  status: PostStatus;
  violations?: Violation[];
  /** The idea in one line, as drafting put it. */
  readonly premise: string;
  /** Who stops scrolling, and why. */
  readonly forWhom: string;
  readonly shots: Shot[];
  readonly caption: string;
  videoPath?: string;
  instagramId?: string;
  readonly createdAt: string;
  decidedAt?: string;
  /** A person's note on rejecting, so drafting can avoid the shape. */
  note?: string;
}

/** Local date, not toISOString(): a post queued at 11pm belongs to that
 *  evening, not to tomorrow in UTC. */
const localDay = (iso: string): string => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export class Store {
  readonly #root: string;

  constructor(readonly slug: string) {
    this.#root = join(workspaceDir(slug), 'content');
  }

  save(post: Post): string {
    const dir = join(this.#root, localDay(post.createdAt));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${post.id}.json`);
    writeFileSync(path, `${JSON.stringify(post, null, 2)}\n`, 'utf8');
    return path;
  }

  /** Every post, newest day first. */
  all(): Post[] {
    if (!existsSync(this.#root)) return [];
    const out: Post[] = [];
    for (const day of readdirSync(this.#root).sort().reverse()) {
      if (day.startsWith('_')) continue; // _renders
      let names: string[];
      try {
        names = readdirSync(join(this.#root, day)).filter((n) => n.endsWith('.json'));
      } catch {
        continue;
      }
      for (const n of names) {
        try {
          out.push(JSON.parse(readFileSync(join(this.#root, day, n), 'utf8')) as Post);
        } catch {
          // A file we cannot parse is skipped rather than fatal: somebody
          // may have hand-edited it, which is allowed and encouraged.
          console.warn(`  (skipping unreadable ${day}/${n})`);
        }
      }
    }
    return out;
  }

  byStatus(s: PostStatus): Post[] {
    return this.all().filter((p) => p.status === s);
  }

  /**
   * What has been proposed before, as one-line premises.
   *
   * This is the entire memory of the system. Without it a daily generator
   * converges on its favourite idea inside a week and the account reads as
   * a loop. Rejections are included with their notes, because "no, not
   * this" is the most useful thing a reviewer ever produces.
   */
  recentPremises(channelKey: string, limit = 40): string[] {
    return this.all()
      .filter((p) => p.channel === channelKey)
      .slice(0, limit)
      .map((p) =>
        p.status === 'rejected'
          ? `${p.premise}  [rejected${p.note ? `: ${p.note}` : ''}]`
          : p.premise,
      );
  }

  rendersDir(): string {
    const d = join(this.#root, '_renders');
    mkdirSync(d, { recursive: true });
    return d;
  }
}
