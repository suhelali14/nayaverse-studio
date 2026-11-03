import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { verifyAccountToken } from "../lib/jwt.js";
import { findAccountById, isTokenRevoked, type AccountRecord } from "../lib/store.js";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * The account this request arrived as, or null.
     *
     * The whole record, including `passwordHash`, because the hook had to
     * load it to know the account still exists and a second read per
     * request to avoid holding a field nobody returns would be the wrong
     * trade. Nothing is allowed to serialise it: routes answer with
     * `toAccount(...)`, and `test/api.test.mts` scans every response the
     * suite produces to prove it.
     */
    studioAccount: AccountRecord | null;
    /** This token's id, so `logout` can revoke exactly this one. */
    studioTokenId: string | null;
    /** Epoch seconds. Bounds how long the revoked id has to be kept. */
    studioTokenExpiresAt: number | null;
  }
}

/**
 * Reads the bearer token on every request and resolves it, or does not.
 *
 * Deliberately never rejects. A hook that 401s would also 401 the login
 * route and the health check; it is `requireAccount` below that refuses,
 * at the routes that need an account. The hook's only job is to answer
 * "who is this" honestly, including "nobody".
 *
 * Four things have to be true, and all four are checked against the store
 * rather than taken from the token:
 *
 *   1. the signature is ours and in date  (`verifyAccountToken`)
 *   2. the token has not been signed out  (`isTokenRevoked`)
 *   3. the account still exists
 *   4. ...and that is it. There are no roles in this product yet, so
 *      there is nothing else to re-read. Ownership is enforced per
 *      resource in the store accessors, not here.
 */
const authPlugin: FastifyPluginAsync = async (app) => {
  app.decorateRequest("studioAccount", null);
  app.decorateRequest("studioTokenId", null);
  app.decorateRequest("studioTokenExpiresAt", null);

  app.addHook("onRequest", async (request) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return;
    const token = header.slice("Bearer ".length);

    try {
      const payload = verifyAccountToken(token);

      // A valid signature is not authorisation: this is what makes
      // `POST /auth/logout` mean something rather than being the browser
      // forgetting a credential that still works.
      if (await isTokenRevoked(payload.jti)) return;

      const account = await findAccountById(payload.accountId);
      if (!account) return;

      request.studioAccount = account;
      request.studioTokenId = payload.jti;
      request.studioTokenExpiresAt = payload.expiresAt;
    } catch {
      // Expired, forged, or truncated by a proxy. Left as nobody either
      // way -- failing closed, and deliberately without logging the
      // token, which is a live credential right up until it is not.
    }
  });
};

export default fp(authPlugin);

/**
 * The account, or a 401 already sent.
 *
 * Returns the record so a route does not re-read it: `region` and `planId`
 * are needed by nearly every one of them, and a second lookup per request
 * against a store that holds everything in memory is pure ceremony.
 *
 * The message is the client's own wording for a 401, which is what it
 * shows when the server sends none -- so the two cannot disagree.
 */
export function requireAccount(
  request: FastifyRequest,
  reply: FastifyReply,
): AccountRecord | null {
  if (!request.studioAccount) {
    reply.status(401).send({ error: "Your session has expired. Sign in again." });
    return null;
  }
  return request.studioAccount;
}
