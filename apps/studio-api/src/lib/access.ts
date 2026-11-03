import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env.js";
import { requireAccount } from "../plugins/auth.js";
import type { AccountRecord } from "./store.js";
import { requirePlan } from "./usage.js";

/**
 * Who may do what, in one place.
 *
 *   signed-in      any route that reads the account's own data
 *   plan:active    anything that creates or costs money -- projects, AI,
 *                  ideas -- needs a plan, and a paid one when payments are on
 *   admin          operator views across accounts
 *
 * There is no endpoint that grants admin. The role comes from
 * STUDIO_ADMIN_EMAILS in the server's environment, read on every request,
 * so the only way to become an administrator is to be given shell access
 * to the server -- which is the access an administrator has anyway.
 */

export type Permission = "plan:active" | "admin";

export function isAdmin(account: AccountRecord): boolean {
  return env.ADMIN_EMAIL_LIST.includes(account.email);
}

/**
 * The account, if it may do this; otherwise null, with the refusal already
 * sent: 401 for no session, 402 for an unpaid plan, 403 for the rest.
 */
export function authorize(request: FastifyRequest, reply: FastifyReply, permission: Permission): AccountRecord | null {
  const account = requireAccount(request, reply);
  if (!account) return null;
  if (permission === "admin") {
    if (isAdmin(account)) return account;
    // Not "admins only": the response does not confirm the route exists.
    reply.status(404).send({ error: "Not found." });
    return null;
  }
  const refusal = requirePlan(account);
  if (refusal) {
    reply.status(refusal.status).send({ error: refusal.error, ...(refusal.field ? { field: refusal.field } : {}) });
    return null;
  }
  return account;
}
