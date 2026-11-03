import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { env } from "../config/env.js";
import { UnsafeInput, cleanDeep } from "../lib/sanitize.js";

/**
 * The layer every request passes through, before and after its route.
 *
 *   in   every JSON body and query string is cleaned (`lib/sanitize.ts`):
 *        NFC, no control characters, no prototype-pollution keys, bounded
 *        depth. A route's zod schema then validates the clean value.
 *   out  security headers on every response; `Cache-Control: no-store` on
 *        anything answered for a signed-in account, so a shared computer's
 *        browser cache never holds someone's projects or payments; and the
 *        request id, so a report from a creator can be found in the log.
 *
 * Registered before the routes and wrapped with `fastify-plugin`, so the
 * hooks apply app-wide rather than to one encapsulated scope.
 */
const securityPlugin: FastifyPluginAsync = async (app) => {
  app.addHook("preValidation", async (request, reply) => {
    try {
      // A string body is the Cashfree webhook's raw payload, which must
      // reach its signature check byte for byte; it is left alone.
      if (request.body !== null && typeof request.body === "object" && !Buffer.isBuffer(request.body)) {
        request.body = cleanDeep(request.body);
      }
      if (request.query && typeof request.query === "object") {
        request.query = cleanDeep(request.query) as typeof request.query;
      }
    } catch (error) {
      if (error instanceof UnsafeInput) {
        return reply.status(400).send({ error: error.message });
      }
      throw error;
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-request-id", request.id);
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cross-origin-resource-policy", "same-site");
    // An API answers data, never a page: nothing it returns may run script
    // or be framed, even if a browser is talked into rendering it.
    reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
    if (env.NODE_ENV === "production") {
      reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
    if (request.studioAccount && !reply.hasHeader("cache-control")) {
      reply.header("cache-control", "no-store");
    }
    return payload;
  });
};

export default fp(securityPlugin, { name: "studio-security" });
