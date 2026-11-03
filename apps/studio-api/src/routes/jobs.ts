import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { invalidBody, sendError } from "../lib/http.js";
import { toJob } from "../lib/mappers.js";
import { findProject, listJobs } from "../lib/store.js";
import { requireAccount } from "../plugins/auth.js";

/**
 * `GET /jobs?projectId=` -- how the client learns a job finished.
 *
 * The contract polls this. There is no websocket and no SSE: a reel's
 * three jobs take seconds, a poll costs one in-memory filter, and a push
 * channel would be a second way for the state on screen to be wrong.
 */

const querySchema = z.object({
  /** Optional: the contract calls it both ways. */
  projectId: z.string().min(1).optional(),
});

export async function jobRoutes(app: FastifyInstance) {
  app.get("/api/jobs", async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;

    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return invalidBody(reply, parsed.error);
    const { projectId } = parsed.data;

    /**
     * A filter by someone else's project id is a 404, not an empty list.
     *
     * `listJobs` is already scoped to the account, so the empty list would
     * have been safe -- nothing leaks either way. But "no jobs" and "not
     * your project" are different facts, and answering the second with
     * the first is how a client ends up polling forever for a job it is
     * never going to be shown.
     */
    if (projectId !== undefined) {
      const project = await findProject(account.id, projectId);
      if (!project) {
        return sendError(reply, 404, "That project does not exist, or is not yours.");
      }
    }

    return (await listJobs(account.id, projectId)).map(toJob);
  });
}
