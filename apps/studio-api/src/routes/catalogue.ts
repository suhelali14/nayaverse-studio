import type { FastifyInstance } from "fastify";
import { CATALOGUE } from "../../../studio/src/lib/catalogue.js";

/**
 * The plans, prices and languages, for the web app to render.
 *
 * Public: the landing and pricing pages show it to visitors who have not
 * signed up. Served from the same module the API enforces limits from, so
 * the price on the page and the limit on the account are one value.
 *
 * Cacheable for five minutes. The catalogue changes on a deploy, not per
 * request, and a pricing page that refetches on every visit is load for
 * nothing; five minutes is short enough that a price change reaches every
 * open tab well inside a working session.
 */
export async function catalogueRoutes(app: FastifyInstance) {
  app.get("/api/catalogue", async (_request, reply) => {
    reply.header("cache-control", "public, max-age=300");
    return CATALOGUE;
  });
}
