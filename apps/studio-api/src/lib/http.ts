import type { FastifyReply } from "fastify";
import type { z } from "zod";
import type { Refusal } from "./usage.js";

/**
 * The error envelope, in one place.
 *
 * `apps/studio-web/src/lib/api.ts` reads `error`, falls back to `message`,
 * and carries `field` onto its `ApiError` so a form can mark the input
 * that was wrong. So every failure from this API is `{ error, field? }`
 * and nothing else -- a route that sends a zod `flatten()` blob instead
 * gives the client nothing it can render, which is how a signup form ends
 * up saying "Something went wrong" to somebody whose password was four
 * characters.
 */
export interface ErrorBody {
  readonly error: string;
  readonly field?: string;
}

export const sendError = (
  reply: FastifyReply,
  status: number,
  error: string,
  field?: string,
): FastifyReply =>
  reply.status(status).send(field === undefined ? { error } : { error, field });

export const sendRefusal = (reply: FastifyReply, refusal: Refusal): FastifyReply =>
  sendError(reply, refusal.status, refusal.error, refusal.field);

/**
 * The first zod issue, as a message and a field name.
 *
 * One issue rather than all of them: the client's `ApiError` holds a
 * single `field`, so a list would have to be collapsed somewhere and the
 * server knows the order the form is in. Each schema in `routes/` gives
 * its fields their own messages for exactly this reason -- zod's defaults
 * ("String must contain at least 10 character(s)") are accurate and read
 * like a compiler.
 */
export function invalidBody(reply: FastifyReply, error: z.ZodError): FastifyReply {
  const issue = error.issues[0];
  const path = issue?.path.filter((part): part is string => typeof part === "string") ?? [];
  const field = path.length > 0 ? path.join(".") : undefined;
  return sendError(reply, 400, issue?.message ?? "That request was not valid.", field);
}
