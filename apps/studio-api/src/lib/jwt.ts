import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

/**
 * Twelve hours, matching the clinic API.
 *
 * A creator editing a reel is in one sitting; a token that outlives the
 * laptop it was issued on is a credential sitting in a browser nobody
 * remembers signing into.
 */
const EXPIRES_IN = "12h";

export interface StudioTokenPayload {
  readonly accountId: string;
  /**
   * This token's own id.
   *
   * The signature proves only that we signed it. The `jti` is what makes a
   * single token cancellable: `POST /auth/logout` records it as revoked and
   * the auth hook refuses it from then on. Without this, signing out would
   * mean the browser forgetting a credential that still works for twelve
   * hours -- which on a shared machine is not signing out.
   */
  readonly jti: string;
  /** Epoch seconds, as the JWT carries it. Used to prune the revoke list. */
  readonly expiresAt: number;
}

export interface IssuedToken {
  readonly token: string;
  readonly jti: string;
  readonly expiresAt: number;
}

export function signAccountToken(accountId: string): IssuedToken {
  const jti = randomUUID();
  const token = jwt.sign({ sub: accountId, jti }, env.JWT_SECRET, { expiresIn: EXPIRES_IN });
  // Read back rather than computed, so the two can never disagree about
  // when this token dies.
  const decoded = jwt.decode(token);
  const expiresAt =
    decoded && typeof decoded === "object" && typeof decoded.exp === "number" ? decoded.exp : 0;
  return { token, jti, expiresAt };
}

/** Throws on anything that is not a token we signed, for an account. */
export function verifyAccountToken(token: string): StudioTokenPayload {
  const payload = jwt.verify(token, env.JWT_SECRET);
  if (
    typeof payload === "string" ||
    typeof payload.sub !== "string" ||
    typeof payload.jti !== "string" ||
    typeof payload.exp !== "number"
  ) {
    throw new Error("Invalid token payload");
  }
  return { accountId: payload.sub, jti: payload.jti, expiresAt: payload.exp };
}
