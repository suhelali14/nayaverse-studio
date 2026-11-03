import { statSync } from 'node:fs';
import { instagramFor } from '../config/env.js';
import type { Post } from './store.js';

/**
 * Publishing a reel through Meta's Content Publishing API.
 *
 * ── The shape, and the two things that surprise people ──────────────
 *
 * It is two steps: create a container, then publish it. For a reel the
 * video does NOT go to graph.facebook.com — it goes to rupload.facebook.com,
 * which is the one host in the whole API that takes a file body. That is
 * also what makes a local-first studio possible at all: images have to be
 * fetched by Meta from a public URL, but a reel can be uploaded from disk.
 *
 * The second surprise is Page Publishing Authorization. If the Facebook
 * Page behind the Instagram account has not completed PPA, publishing is
 * refused and the error does not mention PPA, so it reads as a permissions
 * bug for as long as you let it.
 *
 * Requirements, from Meta's own docs: an Instagram **professional** account,
 * and the permissions `instagram_business_basic` +
 * `instagram_business_content_publish` (Instagram Login) or
 * `instagram_basic` + `instagram_content_publish` + `pages_read_engagement`
 * (Facebook Login).
 *
 * ── Untested ─────────────────────────────────────────────────────────
 *
 * This code has never run against the real API: it needs three accounts, a
 * Meta app and tokens that do not exist yet. It typechecks and the request
 * shapes follow the documentation. Treat the first real run as the test, on
 * one account, with something you would not mind deleting.
 */

const GRAPH = 'https://graph.facebook.com/v23.0';
const RUPLOAD = 'https://rupload.facebook.com/ig-api-upload/v23.0';

export class InstagramError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
    this.name = 'InstagramError';
  }
}

/** What Meta sends back on failure. Only the fields this code reads. */
interface GraphError {
  error?: { message?: string; code?: number; error_subcode?: number };
}

const call = async (url: string, init: RequestInit, what: string): Promise<any> => {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => null)) as (GraphError & Record<string, any>) | null;
  if (!res.ok) {
    const err = body?.error;
    // Meta's rate-limit refusal arrives as code 9 / subcode 2207042, which
    // means back off rather than retry -- and the quota is readable, so the
    // message says to read it instead of guessing.
    const hint =
      err?.code === 9
        ? ' (publishing quota reached; check content_publishing_limit before retrying)'
        : err?.message?.includes('Publishing Authorization')
          ? ' (the Page needs Page Publishing Authorization completed)'
          : '';
    throw new InstagramError(
      `${what} failed: HTTP ${res.status} ${err?.message ?? ''}${hint}`,
      body,
    );
  }
  return body;
};

/**
 * How many posts this account has left in the rolling 24 hours.
 *
 * Checked before publishing rather than after being refused. Meta's own
 * documentation gives two different caps on one page -- 100 in the rate
 * limit section and 50 in the carousel section -- so the number is read
 * from the account rather than assumed from the docs.
 */
export async function quotaFor(workspace: string, channelKey: string): Promise<{ used: number } | null> {
  const creds = instagramFor(workspace, channelKey);
  if (!creds) return null;
  const body = await call(
    `${GRAPH}/${creds.igUserId}/content_publishing_limit?fields=quota_usage&access_token=${encodeURIComponent(creds.token)}`,
    { method: 'GET' },
    'reading the publishing quota',
  );
  return { used: Number(body?.data?.[0]?.quota_usage ?? 0) };
}

export interface Published {
  instagramId: string;
}

export async function publishReel(
  workspace: string,
  channelKey: string,
  post: Post,
): Promise<Published> {
  const creds = instagramFor(workspace, channelKey);
  if (!creds) {
    throw new InstagramError(
      `No Instagram credentials for ${workspace}/${channelKey}. Add them to STUDIO_CREDENTIALS.`,
    );
  }
  if (!post.videoPath) {
    throw new InstagramError('This post has not been rendered yet.');
  }
  const bytes = statSync(post.videoPath).size;

  // 1. A container, declared as a reel and as a resumable upload.
  const container = await call(
    `${GRAPH}/${creds.igUserId}/media`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        media_type: 'REELS',
        upload_type: 'resumable',
        caption: post.caption,
        access_token: creds.token,
      }),
    },
    'creating the reel container',
  );
  const containerId = container?.id as string | undefined;
  if (!containerId) throw new InstagramError('No container id came back', container);

  // 2. The bytes, to the upload host. This is the only call that does not
  //    go to graph.facebook.com.
  const file = await import('node:fs').then((fs) => fs.readFileSync(post.videoPath!));
  await call(
    `${RUPLOAD}/${containerId}`,
    {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${creds.token}`,
        offset: '0',
        file_size: String(bytes),
        'content-type': 'application/octet-stream',
      },
      body: file,
    },
    'uploading the video',
  );

  // 3. Publish. The container is processed asynchronously, so a publish
  //    straight after the upload can be refused while it is still being
  //    transcoded -- hence the wait on status_code rather than a blind retry.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status = await call(
      `${GRAPH}/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(creds.token)}`,
      { method: 'GET' },
      'checking the container',
    );
    const code = status?.status_code as string | undefined;
    if (code === 'FINISHED') break;
    if (code === 'ERROR' || code === 'EXPIRED') {
      throw new InstagramError(`The container ended as ${code}: ${status?.status ?? ''}`, status);
    }
    await new Promise((r) => setTimeout(r, 4000));
    if (attempt === 29) {
      throw new InstagramError('The container never finished processing after two minutes.');
    }
  }

  const published = await call(
    `${GRAPH}/${creds.igUserId}/media_publish`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ creation_id: containerId, access_token: creds.token }),
    },
    'publishing',
  );

  const id = published?.id as string | undefined;
  if (!id) throw new InstagramError('Published, but no media id came back', published);
  return { instagramId: id };
}
