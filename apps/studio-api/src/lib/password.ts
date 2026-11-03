import bcrypt from "bcryptjs";

/**
 * Cost 12, not the clinic API's 10.
 *
 * Twelve is roughly four times the work of ten, which costs this process
 * about a quarter of a second per sign-in and costs someone grinding a
 * leaked table four times as much. Sign-in is not a hot path -- a creator
 * signs in once a day, not once a request -- so the only thing being spent
 * here is an attacker's money.
 */
const COST = 12;

/**
 * bcrypt ignores everything past 72 bytes of input.
 *
 * Not a limit we chose; it is in the algorithm. Worth naming here because
 * the failure mode is silent: a 100-character passphrase and its first 72
 * characters are the same password as far as `compare` is concerned, and
 * nobody would ever find out. The signup schema refuses longer input with
 * a message rather than quietly truncating it.
 */
export const MAX_PASSWORD_BYTES = 72;

export const hashPassword = (password: string): Promise<string> => bcrypt.hash(password, COST);

export const verifyPassword = (password: string, hash: string): Promise<boolean> =>
  bcrypt.compare(password, hash);

/**
 * A hash of nothing in particular, for the login path to compare against
 * when the email does not exist.
 *
 * Without it, an unknown email returns in a millisecond and a known one
 * takes a quarter of a second, which is a reliable account-enumeration
 * oracle however carefully the two responses are worded. Comparing against
 * this instead costs the same quarter second.
 *
 * Generated once at module load rather than being a constant in the source,
 * so there is no committed hash for anyone to feed to a cracker and wonder
 * about.
 */
const dummyHash: Promise<string> = bcrypt.hash("password-that-matches-no-account", COST);

/** Burn the same time an honest comparison would. Always false. */
export const consumeTimingEquivalent = async (password: string): Promise<false> => {
  await bcrypt.compare(password, await dummyHash);
  return false;
};
