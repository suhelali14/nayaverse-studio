import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { env } from "../config/env.js";
import { storeFile } from "../lib/store.js";

export async function healthRoutes(app: FastifyInstance) {
  /**
   * Can this process actually serve?
   *
   * The store is reported because it is this app's database: an
   * unwritable data directory means every signup and every project fails,
   * while the process keeps answering 200 to a check that only looked at
   * whether it was running.
   *
   * `simulated` is on the health check deliberately. It is the one piece
   * of configuration that changes what the data in this deployment
   * *means*, and a deployment that is quietly inventing transcripts
   * should say so somewhere a human will look.
   */
  app.get("/health", async () => {
    const file = storeFile();
    // `existsSync` is false before the first write, which is correct and
    // not a fault -- a fresh deployment has no store yet.
    const dataDirReady = existsSync(env.DATA_DIR);
    return {
      status: dataDirReady ? "ok" : "degraded",
      service: "studio-api",
      checks: {
        store: dataDirReady ? "ok" : "data directory missing",
        storeFile: existsSync(file) ? "present" : "not yet written",
      },
      jobs: env.SIMULATE_JOBS ? "simulated" : "provider",
      timestamp: new Date().toISOString(),
    };
  });
}
