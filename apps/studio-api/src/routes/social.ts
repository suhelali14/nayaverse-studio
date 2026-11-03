import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildReport, type Platform } from "../../../studio/src/lib/insights.js";
import { env } from "../config/env.js";
import { sendError, invalidBody } from "../lib/http.js";
import { AiUnavailable } from "../lib/ai.js";
import { ideasFromReport, type IdeaModel } from "../lib/ideas.js";
import { PlatformError, seal, unseal, type Adapters, type TokenSet } from "../lib/social.js";
import {
  deleteConnection,
  findConnection,
  listConnections,
  listPosts,
  putConnection,
  replacePosts,
  updateConnection,
  type AccountRecord,
  type ConnectionRecord,
} from "../lib/store.js";
import { authorize } from "../lib/access.js";
import { runAi } from "../lib/ai-gateway.js";
import { requireAccount } from "../plugins/auth.js";

/**
 * Connections, Insights and Ideas.
 *
 *   GET    /api/connections                    every platform, and this account's link to it
 *   POST   /api/connections/:platform/start    the platform's sign-in address
 *   GET    /api/connections/:platform/callback the platform sends the browser back here
 *   POST   /api/connections/:platform/sync     fetch the latest posts and numbers
 *   DELETE /api/connections/:platform          forget the tokens and the posts
 *   GET    /api/insights?platform=             the report over synced posts
 *   POST   /api/ideas                          what to make next
 *
 * TikTok is not offered to accounts in India, where the app is not
 * available; the region is the one chosen at sign-up.
 */

const PLATFORMS: readonly Platform[] = ["instagram", "youtube", "tiktok"];
const platformSchema = z.enum(["instagram", "youtube", "tiktok"]);

/** Who started which sign-in. In memory, like the rest of this store: one process. */
const pending = new Map<string, { accountId: string; platform: Platform; expires: number }>();
const STATE_TTL_MS = 10 * 60_000;

const apiBase = () => env.PUBLIC_API_URL ?? `http://localhost:${env.PORT}`;
const redirectUri = (platform: Platform) => `${apiBase()}/api/connections/${platform}/callback`;
const webBack = (query: string) => `${env.PUBLIC_WEB_URL}/app/connections?${query}`;

const availableIn = (platform: Platform, account: AccountRecord) => !(platform === "tiktok" && account.region === "IN");

const tokensOf = (c: ConnectionRecord): TokenSet => ({
  accessToken: unseal(c.accessTokenSealed),
  refreshToken: c.refreshTokenSealed ? unseal(c.refreshTokenSealed) : null,
  expiresAt: c.expiresAt,
  externalId: c.externalId,
});

const toConnection = (c: ConnectionRecord, posts: number) => ({
  handle: c.handle,
  displayName: c.displayName,
  avatar: c.avatar,
  followers: c.followers,
  connectedAt: c.connectedAt,
  lastSyncedAt: c.lastSyncedAt,
  lastError: c.lastError,
  posts,
});

export async function socialRoutes(
  app: FastifyInstance,
  options: { adapters: Adapters; ideaModel: IdeaModel | null; ideasRateLimitMax: number },
) {
  const { adapters, ideaModel } = options;

  /** Refresh if close to expiry, fetch, store. Records the error on the connection either way. */
  async function sync(accountId: string, platform: Platform): Promise<ConnectionRecord> {
    const connection = await findConnection(accountId, platform);
    if (!connection) throw new PlatformError("That account is not connected.");
    const adapter = adapters[platform];
    try {
      let tokens = tokensOf(connection);
      if (tokens.expiresAt && Date.parse(tokens.expiresAt) - Date.now() < 86_400_000) {
        const refreshed = await adapter.refresh(tokens);
        if (refreshed) {
          tokens = refreshed;
          await updateConnection(accountId, platform, {
            accessTokenSealed: seal(refreshed.accessToken),
            refreshTokenSealed: refreshed.refreshToken ? seal(refreshed.refreshToken) : null,
            expiresAt: refreshed.expiresAt,
          });
        }
      }
      const [profile, posts] = await Promise.all([adapter.profile(tokens), adapter.posts(tokens)]);
      await replacePosts(accountId, platform, posts);
      return (await updateConnection(accountId, platform, {
        handle: profile.handle,
        displayName: profile.displayName,
        avatar: profile.avatar,
        followers: profile.followers,
        lastSyncedAt: new Date().toISOString(),
        lastError: null,
      }))!;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateConnection(accountId, platform, { lastError: message });
      throw error instanceof PlatformError ? error : new PlatformError(message);
    }
  }

  app.get("/api/connections", async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    const [connections, posts] = await Promise.all([listConnections(account.id), listPosts(account.id)]);
    return {
      platforms: PLATFORMS.filter((p) => availableIn(p, account)).map((p) => {
        const c = connections.find((x) => x.platform === p);
        return {
          id: p,
          name: adapters[p].name,
          configured: adapters[p].configured,
          connection: c ? toConnection(c, posts.filter((x) => x.platform === p).length) : null,
        };
      }),
    };
  });

  app.post("/api/connections/:platform/start", async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    const parsed = platformSchema.safeParse((request.params as { platform?: string }).platform);
    if (!parsed.success) return sendError(reply, 404, "Unknown platform.");
    const platform = parsed.data;
    if (!availableIn(platform, account)) return sendError(reply, 403, `${adapters[platform].name} is not available in your region.`);
    if (!adapters[platform].configured) {
      return sendError(reply, 409, `${adapters[platform].name} is not set up on this server yet.`);
    }
    const now = Date.now();
    for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
    const state = randomBytes(24).toString("base64url");
    pending.set(state, { accountId: account.id, platform, expires: now + STATE_TTL_MS });
    return { url: adapters[platform].authorizeUrl(state, redirectUri(platform)) };
  });

  /**
   * The browser lands here from the platform. No bearer token comes with a
   * redirect, so the account is the one that started this sign-in, found
   * by the single-use state -- which is also what stops someone else's
   * callback being attached to this account.
   */
  app.get("/api/connections/:platform/callback", async (request, reply) => {
    const parsed = platformSchema.safeParse((request.params as { platform?: string }).platform);
    const query = request.query as { code?: string; state?: string; error?: string; error_description?: string };
    if (!parsed.success) return reply.redirect(webBack("error=unknown-platform"));
    const platform = parsed.data;
    const started = query.state ? pending.get(query.state) : undefined;
    if (query.state) pending.delete(query.state);
    if (!started || started.platform !== platform || started.expires < Date.now()) {
      return reply.redirect(webBack(`error=${encodeURIComponent("That sign-in expired. Try connecting again.")}`));
    }
    if (query.error || !query.code) {
      return reply.redirect(webBack(`error=${encodeURIComponent(query.error_description ?? "The connection was cancelled.")}`));
    }

    try {
      const adapter = adapters[platform];
      const tokens = await adapter.exchange(query.code, redirectUri(platform));
      const profile = await adapter.profile(tokens);
      await putConnection({
        accountId: started.accountId,
        platform,
        externalId: tokens.externalId,
        handle: profile.handle,
        displayName: profile.displayName,
        avatar: profile.avatar,
        followers: profile.followers,
        accessTokenSealed: seal(tokens.accessToken),
        refreshTokenSealed: tokens.refreshToken ? seal(tokens.refreshToken) : null,
        expiresAt: tokens.expiresAt,
        connectedAt: new Date().toISOString(),
        lastSyncedAt: null,
        lastError: null,
      });
      try {
        await sync(started.accountId, platform);
      } catch {
        /* recorded on the connection; the page shows it with a retry */
      }
      return reply.redirect(webBack(`connected=${platform}`));
    } catch (error) {
      request.log.warn({ err: error instanceof Error ? error.message : String(error), platform }, "connection failed");
      const message = error instanceof PlatformError ? error.message : "The connection could not be completed.";
      return reply.redirect(webBack(`error=${encodeURIComponent(message)}`));
    }
  });

  app.post("/api/connections/:platform/sync", async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    const parsed = platformSchema.safeParse((request.params as { platform?: string }).platform);
    if (!parsed.success) return sendError(reply, 404, "Unknown platform.");
    try {
      const c = await sync(account.id, parsed.data);
      return toConnection(c, (await listPosts(account.id, parsed.data)).length);
    } catch (error) {
      return sendError(reply, 502, error instanceof Error ? error.message : String(error));
    }
  });

  app.delete("/api/connections/:platform", async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    const parsed = platformSchema.safeParse((request.params as { platform?: string }).platform);
    if (!parsed.success) return sendError(reply, 404, "Unknown platform.");
    await deleteConnection(account.id, parsed.data);
    return { ok: true };
  });

  app.get("/api/insights", async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    const q = request.query as { platform?: string };
    const platform = q.platform && q.platform !== "all" ? platformSchema.safeParse(q.platform) : null;
    if (platform && !platform.success) return sendError(reply, 400, "Unknown platform.");
    const posts = await listPosts(account.id, platform?.data);
    return { report: buildReport(posts), connected: (await listConnections(account.id)).length };
  });

  const ideaSchema = z.object({
    niche: z.string().trim().max(200).default(""),
    audience: z.string().trim().max(200).optional(),
    language: z.string().trim().min(2).max(10).default("en"),
    platform: z.enum(["all", "instagram", "youtube", "tiktok"]).default("all"),
  });

  app.post(
    "/api/ideas",
    { config: { rateLimit: { max: options.ideasRateLimitMax, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const account = authorize(request, reply, "plan:active");
      if (!account) return;
      const parsed = ideaSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalidBody(reply, parsed.error);

      const posts = await listPosts(account.id, parsed.data.platform === "all" ? undefined : parsed.data.platform);
      const input = {
        niche: parsed.data.niche,
        audience: parsed.data.audience ?? null,
        language: parsed.data.language,
        report: buildReport(posts),
      };
      if (ideaModel) {
        try {
          const ideas = await runAi(account, "ideas", ideaModel.name, () => ideaModel.ideas(input));
          return { ideas, source: "model" as const, model: ideaModel.name };
        } catch (error) {
          if (error instanceof AiUnavailable) {
            request.log.warn({ detail: error.detail }, "ideas model failed; falling back to rules");
            return {
              ideas: ideasFromReport(input),
              source: "rules" as const,
              model: null,
              note: error.publicMessage + " These ideas come from your numbers alone.",
            };
          }
          throw error;
        }
      }
      return { ideas: ideasFromReport(input), source: "rules" as const, model: null };
    },
  );
}
