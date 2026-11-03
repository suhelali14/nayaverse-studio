import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { REGIONS } from "../config/plans.js";
import { invalidBody, sendError } from "../lib/http.js";
import { signAccountToken } from "../lib/jwt.js";
import { toAccount } from "../lib/mappers.js";
import {
  consumeTimingEquivalent,
  hashPassword,
  MAX_PASSWORD_BYTES,
  verifyPassword,
} from "../lib/password.js";
import { findAccountByEmail, insertAccount, revokeToken } from "../lib/store.js";
import { requireAccount } from "../plugins/auth.js";

/**
 * Signup, login, me, logout. Implements the four `/auth/*` calls in
 * `apps/studio-web/src/lib/api.ts`.
 */

const emailField = z
  .string({ required_error: "Enter your email address." })
  .trim()
  .min(1, "Enter your email address.")
  .max(254, "That email address is too long.")
  .email("That does not look like an email address.");

/**
 * Ten characters, and a ceiling at bcrypt's own limit.
 *
 * Length over character classes: a rule demanding a symbol produces
 * `Password1!` and nothing else. The 72-byte ceiling is not a preference
 * -- see `MAX_PASSWORD_BYTES` -- and refusing with a message beats
 * accepting a 100-character passphrase and silently using the first 72,
 * which nobody would ever discover.
 */
const passwordField = z
  .string({ required_error: "Choose a password." })
  .min(10, "Use at least 10 characters. Length is what makes a password hard to guess.")
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_PASSWORD_BYTES,
    "Passwords are limited to " +
      MAX_PASSWORD_BYTES +
      " bytes, because everything past that is ignored by the hash.",
  );

const signupSchema = z.object({
  email: emailField,
  password: passwordField,
  name: z
    .string({ required_error: "Tell us your name." })
    .trim()
    .min(1, "Tell us your name.")
    .max(120, "That name is too long."),
  region: z.enum(REGIONS, {
    errorMap: () => ({ message: "Choose India or Rest of world." }),
  }),
});

/**
 * Login validates almost nothing, on purpose.
 *
 * `.email()` here would answer a malformed address with a 400 and a
 * well-formed unknown one with a 401, which tells somebody probing the
 * difference more than it tells an honest typist. Everything that is not
 * a correct pair gets the same 401 from the same code path below.
 */
const loginSchema = z.object({
  email: z.string({ required_error: "Enter your email address." }).min(1, "Enter your email address."),
  password: z.string({ required_error: "Enter your password." }).min(1, "Enter your password."),
});

/** One wording, one status, for every way a sign-in can fail. */
const INVALID_CREDENTIALS = "Invalid email or password.";

export interface AuthRouteOptions {
  /** Attempts per IP per minute on signup and login. See `app.ts`. */
  authRateLimitMax: number;
}

export async function authRoutes(app: FastifyInstance, options: AuthRouteOptions) {
  /**
   * The strict limit, applied per route rather than to the whole module.
   *
   * It was a module-wide `onRoute` hook first, which silently did nothing:
   * `@fastify/rate-limit` registers its own `onRoute` hook on the root
   * instance, and a parent's hooks run before a child scope's -- so the
   * limiter had already read the route's config by the time the hook
   * wrote it. The failure mode was an auth route with no limit and a
   * passing test suite, which is the worst of both.
   *
   * Only signup and login carry it. They are the whole brute-force
   * surface; `me` and `logout` need a token already, and `me` is called
   * on every page load, so ten a minute would throttle an honest user
   * reloading. Those two keep the global 300.
   */
  const strict = {
    config: { rateLimit: { max: options.authRateLimitMax, timeWindow: "1 minute" } },
  };

  app.post("/api/auth/signup", strict, async (request, reply) => {
    const parsed = signupSchema.safeParse(request.body);
    if (!parsed.success) return invalidBody(reply, parsed.error);
    const { email, password, name, region } = parsed.data;

    // Hashed before the duplicate check rather than after, so that a
    // taken address and a free one cost the same quarter-second. Signup
    // is the other enumeration oracle people forget about, and this one
    // has to answer honestly -- a form that accepts an address already in
    // use would be worse -- so the least it can do is not also answer
    // instantly.
    const passwordHash = await hashPassword(password);

    // The uniqueness check happens inside the store's write lock, not
    // here: two signups for one address arriving together would both pass
    // a check made out here. See `insertAccount`.
    const created = await insertAccount({ email, name, passwordHash, region });
    if (created === "duplicate") {
      return sendError(
        reply,
        409,
        "That email address is already registered. Sign in instead, or use another address.",
        "email",
      );
    }

    const { token } = signAccountToken(created.id);
    // Logged without the address: an account was created, which is worth
    // knowing, and by whom is not worth writing into a log file that gets
    // shipped somewhere.
    request.log.info({ accountId: created.id, region }, "account created");
    return reply.status(201).send({ token, account: toAccount(created) });
  });

  app.post("/api/auth/login", strict, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return invalidBody(reply, parsed.error);
    const { email, password } = parsed.data;

    const account = await findAccountByEmail(email);

    /**
     * The same answer for an unknown address and a wrong password, in
     * both the body and the time it takes.
     *
     * Two different messages hand an attacker a list of which addresses
     * have accounts, which is a leak on its own -- people reuse
     * passwords, and knowing someone is a customer here is worth
     * something to whoever is phishing them. Two different *timings* leak
     * exactly the same thing to anybody with a stopwatch, which is why
     * the no-account branch still pays for a bcrypt comparison instead of
     * returning immediately. See `consumeTimingEquivalent`.
     */
    const valid = account
      ? await verifyPassword(password, account.passwordHash)
      : await consumeTimingEquivalent(password);

    if (!account || !valid) {
      // No email in the log line. A failed-login log that records the
      // attempted address is a list of addresses in a file that is easier
      // to read than the database.
      request.log.warn({ had_account: Boolean(account) }, "login refused");
      return sendError(reply, 401, INVALID_CREDENTIALS);
    }

    const { token } = signAccountToken(account.id);
    return reply.status(200).send({ token, account: toAccount(account) });
  });

  app.get("/api/auth/me", async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    return toAccount(account);
  });

  /**
   * 204, and the token really stops working -- once the client sends it.
   *
   * ── A live problem in the client contract ───────────────────────────
   *
   * `api.logOut()` in `apps/studio-web/src/lib/api.ts` does this:
   *
   *     setToken(null);
   *     return request('/auth/logout', { method: 'POST' })...
   *
   * `setToken(null)` clears the module-level `token` that `request` reads
   * to build the Authorization header -- so the call that arrives here
   * carries no token, this route has nothing to revoke, and the token the
   * browser just forgot stays valid for the rest of its twelve hours.
   * Anyone who lifted it off a shared machine still has it.
   *
   * Implemented as the contract is written, because the contract is
   * frozen and guessing at the token some other way would be worse. The
   * revocation is built and tested and starts working the moment those two
   * lines swap order on the client. The fix is one line there, not here.
   *
   * Unauthenticated calls get 204 too. There is nothing to reveal, and
   * the client's own `.catch(() => undefined)` says it is not listening.
   */
  app.post("/api/auth/logout", async (request, reply) => {
    if (request.studioTokenId) {
      await revokeToken(request.studioTokenId, request.studioTokenExpiresAt ?? 0);
    }
    return reply.status(204).send();
  });
}
