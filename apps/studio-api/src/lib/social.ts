import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import type { Platform, PostFormat, SocialPost } from "../../../studio/src/lib/insights.js";

/**
 * Instagram, YouTube and TikTok, read-only, behind one interface.
 *
 * ── Read-only, and why ──────────────────────────────────────────────
 *
 * The scopes asked for are the ones that read a profile, its posts and
 * their numbers -- nothing that posts, comments or messages. A creator
 * connecting an account to see their analytics should not be handing over
 * the ability to publish as them, and an app that never asks for it can
 * never misuse it.
 *
 * ── Where these shapes come from ────────────────────────────────────
 *
 *   Instagram  Instagram API with Instagram Login: instagram.com/oauth/
 *              authorize, api.instagram.com/oauth/access_token, then the
 *              long-lived exchange and graph.instagram.com. Professional
 *              (business or creator) accounts only.
 *   YouTube    Google OAuth 2.0, YouTube Data API v3 (channels,
 *              playlistItems, videos).
 *   TikTok     Login Kit v2 and the Display API (user/info, video/list).
 *
 * Each is a developer app the operator registers and puts in `.env`; the
 * redirect address to register is `<PUBLIC_API_URL>/api/connections/
 * <platform>/callback`. Graph API versions move every few months, so the
 * Instagram one is a constant here and the first thing to check when a
 * call starts failing.
 */

const IG_GRAPH = "https://graph.instagram.com/v23.0";

export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  /** ISO, or null when the platform did not say. */
  readonly expiresAt: string | null;
  /** The platform's own id for the account. */
  readonly externalId: string;
}

export interface Profile {
  readonly handle: string;
  readonly displayName: string;
  readonly avatar: string | null;
  readonly followers: number | null;
}

export interface PlatformAdapter {
  readonly id: Platform;
  readonly name: string;
  readonly configured: boolean;
  authorizeUrl(state: string, redirectUri: string): string;
  exchange(code: string, redirectUri: string): Promise<TokenSet>;
  /** Null when the platform has no refresh, or the token cannot be refreshed. */
  refresh(tokens: TokenSet): Promise<TokenSet | null>;
  profile(tokens: TokenSet): Promise<Profile>;
  posts(tokens: TokenSet): Promise<SocialPost[]>;
}

export class PlatformError extends Error {}

// ---------------------------------------------------------------------------
// Token encryption at rest.

/**
 * AES-256-GCM. The key is TOKEN_ENCRYPTION_KEY (32 bytes, base64); in
 * development it is derived from JWT_SECRET so a restart keeps working.
 * Production refuses to boot without a real key once a platform is
 * configured (config/env.ts).
 */
function key(): Buffer {
  if (env.TOKEN_ENCRYPTION_KEY) {
    const k = Buffer.from(env.TOKEN_ENCRYPTION_KEY, "base64");
    if (k.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded.");
    return k;
  }
  return createHash("sha256").update("studio-token-key:" + env.JWT_SECRET).digest();
}

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

export function unseal(sealed: string): string {
  const raw = Buffer.from(sealed, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

// ---------------------------------------------------------------------------

async function json<T>(response: Response, what: string): Promise<T> {
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!response.ok) {
    const b = body as { error?: { message?: string } | string; error_description?: string; message?: string } | null;
    const detail =
      (typeof b?.error === "object" ? b?.error?.message : undefined) ??
      b?.error_description ??
      b?.message ??
      (typeof b?.error === "string" ? b.error : undefined);
    throw new PlatformError(`${what} failed${detail ? `: ${detail}` : ` (${response.status})`}.`);
  }
  return body as T;
}

const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

const inSeconds = (s: number | undefined): string | null =>
  typeof s === "number" && s > 0 ? new Date(Date.now() + s * 1000).toISOString() : null;

// ---------------------------------------------------------------------------
// Instagram.

function instagram(): PlatformAdapter {
  const id = env.INSTAGRAM_APP_ID ?? "";
  const secret = env.INSTAGRAM_APP_SECRET ?? "";
  return {
    id: "instagram",
    name: "Instagram",
    configured: Boolean(id && secret),
    authorizeUrl(state, redirectUri) {
      const q = new URLSearchParams({
        client_id: id,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "instagram_business_basic,instagram_business_manage_insights",
        state,
      });
      return `https://www.instagram.com/oauth/authorize?${q}`;
    },
    async exchange(code, redirectUri) {
      const short = await json<{ access_token?: string; user_id?: string | number; data?: { access_token: string; user_id: string | number }[] }>(
        await fetch("https://api.instagram.com/oauth/access_token", form({
          client_id: id,
          client_secret: secret,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
          code,
        })),
        "Instagram sign-in",
      );
      const first = short.data?.[0] ?? short;
      if (!first.access_token) throw new PlatformError("Instagram did not return a token.");
      // Swap the one-hour token for the sixty-day one.
      const long = await json<{ access_token: string; expires_in?: number }>(
        await fetch(`https://graph.instagram.com/access_token?${new URLSearchParams({
          grant_type: "ig_exchange_token",
          client_secret: secret,
          access_token: first.access_token,
        })}`),
        "Instagram token exchange",
      );
      return { accessToken: long.access_token, refreshToken: null, expiresAt: inSeconds(long.expires_in), externalId: String(first.user_id ?? "") };
    },
    async refresh(tokens) {
      const r = await json<{ access_token: string; expires_in?: number }>(
        await fetch(`https://graph.instagram.com/refresh_access_token?${new URLSearchParams({
          grant_type: "ig_refresh_token",
          access_token: tokens.accessToken,
        })}`),
        "Instagram token refresh",
      );
      return { ...tokens, accessToken: r.access_token, expiresAt: inSeconds(r.expires_in) };
    },
    async profile(tokens) {
      const p = await json<{ username: string; name?: string; profile_picture_url?: string; followers_count?: number }>(
        await fetch(`${IG_GRAPH}/me?${new URLSearchParams({
          fields: "user_id,username,name,profile_picture_url,followers_count,media_count",
          access_token: tokens.accessToken,
        })}`),
        "Reading the Instagram profile",
      );
      return { handle: "@" + p.username, displayName: p.name || p.username, avatar: p.profile_picture_url ?? null, followers: p.followers_count ?? null };
    },
    async posts(tokens) {
      const list = await json<{
        data: {
          id: string;
          caption?: string;
          media_type: string;
          media_product_type?: string;
          permalink?: string;
          timestamp: string;
          like_count?: number;
          comments_count?: number;
          thumbnail_url?: string;
          media_url?: string;
        }[];
      }>(
        await fetch(`${IG_GRAPH}/me/media?${new URLSearchParams({
          fields: "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url,media_url",
          limit: "50",
          access_token: tokens.accessToken,
        })}`),
        "Reading Instagram posts",
      );
      const out: SocialPost[] = [];
      for (const m of list.data ?? []) {
        // Per-post numbers. Metrics differ by media type and by Graph
        // version, so a failed call degrades to the counts already known
        // rather than losing the post.
        let views: number | null = null;
        let reach: number | null = null;
        let shares: number | null = null;
        let saves: number | null = null;
        try {
          const ins = await json<{ data: { name: string; values?: { value: number }[]; total_value?: { value: number } }[] }>(
            await fetch(`${IG_GRAPH}/${m.id}/insights?${new URLSearchParams({
              metric: "views,reach,shares,saved",
              access_token: tokens.accessToken,
            })}`),
            "Instagram insights",
          );
          for (const metric of ins.data ?? []) {
            const v = metric.values?.[0]?.value ?? metric.total_value?.value ?? null;
            if (metric.name === "views") views = v;
            if (metric.name === "reach") reach = v;
            if (metric.name === "shares") shares = v;
            if (metric.name === "saved") saves = v;
          }
        } catch {
          /* counts only */
        }
        const format: PostFormat =
          m.media_product_type === "REELS" ? "reel" : m.media_type === "CAROUSEL_ALBUM" ? "carousel" : m.media_type === "VIDEO" ? "video" : "image";
        out.push({
          platform: "instagram",
          id: m.id,
          publishedAt: new Date(m.timestamp).toISOString(),
          caption: m.caption ?? "",
          url: m.permalink ?? null,
          thumbnail: m.thumbnail_url ?? (m.media_type === "IMAGE" ? (m.media_url ?? null) : null),
          format,
          durationSec: null,
          views,
          reach,
          likes: m.like_count ?? 0,
          comments: m.comments_count ?? 0,
          shares,
          saves,
        });
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// YouTube.

/** ISO 8601 duration ("PT1M5S") to seconds. */
export function isoDuration(value: string): number | null {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!m) return null;
  const [, d, h, min, s] = m;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0);
}

function youtube(): PlatformAdapter {
  const id = env.GOOGLE_CLIENT_ID ?? "";
  const secret = env.GOOGLE_CLIENT_SECRET ?? "";
  const api = "https://www.googleapis.com/youtube/v3";
  const auth = (t: TokenSet) => ({ headers: { authorization: `Bearer ${t.accessToken}` } });
  return {
    id: "youtube",
    name: "YouTube",
    configured: Boolean(id && secret),
    authorizeUrl(state, redirectUri) {
      const q = new URLSearchParams({
        client_id: id,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "https://www.googleapis.com/auth/youtube.readonly",
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state,
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
    },
    async exchange(code, redirectUri) {
      const t = await json<{ access_token: string; refresh_token?: string; expires_in?: number }>(
        await fetch("https://oauth2.googleapis.com/token", form({
          code,
          client_id: id,
          client_secret: secret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        })),
        "Google sign-in",
      );
      const tokens: TokenSet = { accessToken: t.access_token, refreshToken: t.refresh_token ?? null, expiresAt: inSeconds(t.expires_in), externalId: "" };
      const ch = await json<{ items?: { id: string }[] }>(await fetch(`${api}/channels?part=id&mine=true`, auth(tokens)), "Finding the YouTube channel");
      const channel = ch.items?.[0]?.id;
      if (!channel) throw new PlatformError("That Google account has no YouTube channel.");
      return { ...tokens, externalId: channel };
    },
    async refresh(tokens) {
      if (!tokens.refreshToken) return null;
      const t = await json<{ access_token: string; expires_in?: number }>(
        await fetch("https://oauth2.googleapis.com/token", form({
          client_id: id,
          client_secret: secret,
          refresh_token: tokens.refreshToken,
          grant_type: "refresh_token",
        })),
        "Google token refresh",
      );
      return { ...tokens, accessToken: t.access_token, expiresAt: inSeconds(t.expires_in) };
    },
    async profile(tokens) {
      const ch = await json<{ items?: { snippet: { title: string; customUrl?: string; thumbnails?: { default?: { url: string } } }; statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean } }[] }>(
        await fetch(`${api}/channels?part=snippet,statistics&mine=true`, auth(tokens)),
        "Reading the YouTube channel",
      );
      const c = ch.items?.[0];
      if (!c) throw new PlatformError("No YouTube channel on this account.");
      return {
        handle: c.snippet.customUrl ?? c.snippet.title,
        displayName: c.snippet.title,
        avatar: c.snippet.thumbnails?.default?.url ?? null,
        followers: c.statistics?.hiddenSubscriberCount ? null : Number(c.statistics?.subscriberCount ?? 0),
      };
    },
    async posts(tokens) {
      const ch = await json<{ items?: { contentDetails: { relatedPlaylists: { uploads: string } } }[] }>(
        await fetch(`${api}/channels?part=contentDetails&mine=true`, auth(tokens)),
        "Reading the YouTube channel",
      );
      const uploads = ch.items?.[0]?.contentDetails.relatedPlaylists.uploads;
      if (!uploads) return [];
      const items = await json<{ items?: { contentDetails: { videoId: string } }[] }>(
        await fetch(`${api}/playlistItems?part=contentDetails&maxResults=50&playlistId=${encodeURIComponent(uploads)}`, auth(tokens)),
        "Reading YouTube uploads",
      );
      const ids = (items.items ?? []).map((i) => i.contentDetails.videoId);
      if (ids.length === 0) return [];
      const videos = await json<{
        items?: {
          id: string;
          snippet: { publishedAt: string; title: string; description?: string; thumbnails?: { medium?: { url: string } } };
          contentDetails: { duration: string };
          statistics: { viewCount?: string; likeCount?: string; commentCount?: string };
        }[];
      }>(await fetch(`${api}/videos?part=snippet,contentDetails,statistics&id=${ids.join(",")}`, auth(tokens)), "Reading YouTube videos");
      return (videos.items ?? []).map((v) => {
        const seconds = isoDuration(v.contentDetails.duration);
        return {
          platform: "youtube" as const,
          id: v.id,
          publishedAt: new Date(v.snippet.publishedAt).toISOString(),
          caption: [v.snippet.title, v.snippet.description ?? ""].join("\n"),
          url: `https://www.youtube.com/watch?v=${v.id}`,
          thumbnail: v.snippet.thumbnails?.medium?.url ?? null,
          // YouTube's API does not flag Shorts; three minutes is its limit.
          format: seconds !== null && seconds <= 180 ? ("short" as const) : ("video" as const),
          durationSec: seconds,
          views: v.statistics.viewCount === undefined ? null : Number(v.statistics.viewCount),
          reach: null,
          likes: Number(v.statistics.likeCount ?? 0),
          comments: Number(v.statistics.commentCount ?? 0),
          shares: null,
          saves: null,
        };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// TikTok.

function tiktok(): PlatformAdapter {
  const id = env.TIKTOK_CLIENT_KEY ?? "";
  const secret = env.TIKTOK_CLIENT_SECRET ?? "";
  const api = "https://open.tiktokapis.com/v2";
  return {
    id: "tiktok",
    name: "TikTok",
    configured: Boolean(id && secret),
    authorizeUrl(state, redirectUri) {
      const q = new URLSearchParams({
        client_key: id,
        response_type: "code",
        scope: "user.info.basic,user.info.stats,video.list",
        redirect_uri: redirectUri,
        state,
      });
      return `https://www.tiktok.com/v2/auth/authorize/?${q}`;
    },
    async exchange(code, redirectUri) {
      const t = await json<{ access_token: string; refresh_token?: string; expires_in?: number; open_id: string }>(
        await fetch(`${api}/oauth/token/`, form({
          client_key: id,
          client_secret: secret,
          code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        })),
        "TikTok sign-in",
      );
      return { accessToken: t.access_token, refreshToken: t.refresh_token ?? null, expiresAt: inSeconds(t.expires_in), externalId: t.open_id };
    },
    async refresh(tokens) {
      if (!tokens.refreshToken) return null;
      const t = await json<{ access_token: string; refresh_token?: string; expires_in?: number }>(
        await fetch(`${api}/oauth/token/`, form({
          client_key: id,
          client_secret: secret,
          grant_type: "refresh_token",
          refresh_token: tokens.refreshToken,
        })),
        "TikTok token refresh",
      );
      return { ...tokens, accessToken: t.access_token, refreshToken: t.refresh_token ?? tokens.refreshToken, expiresAt: inSeconds(t.expires_in) };
    },
    async profile(tokens) {
      const r = await json<{ data: { user: { display_name: string; avatar_url?: string; follower_count?: number } } }>(
        await fetch(`${api}/user/info/?fields=open_id,display_name,avatar_url,follower_count,video_count`, {
          headers: { authorization: `Bearer ${tokens.accessToken}` },
        }),
        "Reading the TikTok profile",
      );
      const u = r.data.user;
      return { handle: u.display_name, displayName: u.display_name, avatar: u.avatar_url ?? null, followers: u.follower_count ?? null };
    },
    async posts(tokens) {
      const r = await json<{
        data: {
          videos?: {
            id: string;
            title?: string;
            video_description?: string;
            create_time: number;
            cover_image_url?: string;
            share_url?: string;
            duration?: number;
            view_count?: number;
            like_count?: number;
            comment_count?: number;
            share_count?: number;
          }[];
        };
      }>(
        await fetch(`${api}/video/list/?fields=id,title,video_description,create_time,cover_image_url,share_url,duration,view_count,like_count,comment_count,share_count`, {
          method: "POST",
          headers: { authorization: `Bearer ${tokens.accessToken}`, "content-type": "application/json" },
          body: JSON.stringify({ max_count: 20 }),
        }),
        "Reading TikTok videos",
      );
      return (r.data.videos ?? []).map((v) => ({
        platform: "tiktok" as const,
        id: v.id,
        publishedAt: new Date(v.create_time * 1000).toISOString(),
        caption: v.video_description ?? v.title ?? "",
        url: v.share_url ?? null,
        thumbnail: v.cover_image_url ?? null,
        format: "short" as const,
        durationSec: v.duration ?? null,
        views: v.view_count ?? null,
        reach: null,
        likes: v.like_count ?? 0,
        comments: v.comment_count ?? 0,
        shares: v.share_count ?? null,
        saves: null,
      }));
    },
  };
}

export type Adapters = Readonly<Record<Platform, PlatformAdapter>>;

export function resolveAdapters(): Adapters {
  return { instagram: instagram(), youtube: youtube(), tiktok: tiktok() };
}
