/**
 * The shared-password session.
 *
 * A dashboard that can deploy code and has no authentication is not a milestone, it is an incident
 * waiting to be written up — so this ships in the same increment as the first mutation, per the
 * implementation plan.
 *
 * The mechanism is deliberately the smallest thing that is actually safe for a single-team internal
 * tool: one shared password in `DEPLOYHUB_PASSWORD`, and a cookie holding an HMAC derived from it.
 * There are no user records, no session store, and nothing to expire — a leaked cookie is exactly
 * as bad as a leaked password, which is a property worth stating rather than hiding.
 *
 * Web Crypto rather than `node:crypto` because this runs in middleware.
 */

export const SESSION_COOKIE = "deployhub_session";

/** Constant across restarts, so a session survives a redeploy of DeployHub itself. */
const SESSION_MESSAGE = "deployhub-session-v1";

/**
 * Whether the dashboard is allowed to serve at all.
 *
 * With no password configured the answer is no. Failing closed is the only defensible default for a
 * tool whose primary action is "change what production is running".
 */
export function isConfigured(password: string | undefined): password is string {
  return password !== undefined && password.length >= 8;
}

/** The value a valid cookie must hold. Recomputed on every request; nothing is stored. */
export async function expectedToken(password: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(SESSION_MESSAGE),
  );
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Compare in constant time.
 *
 * The length check leaks only the length, which is fixed for a SHA-256 digest, so it reveals
 * nothing. The loop deliberately does not exit early.
 */
export function tokensMatch(a: string | undefined, b: string): boolean {
  if (a === undefined || a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}
