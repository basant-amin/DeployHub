/**
 * `Result<T, E>` — expected failures as values.
 *
 * The domain never throws for a failure it anticipated: invalid input, an illegal
 * transition, and an ineligible rollback are all outcomes a caller must handle, and
 * an exception makes that obligation invisible to the type checker. Thrown errors
 * are reserved for genuine programmer error.
 *
 * Deliberately spare. The codebase's idiom is an explicit `if (!result.ok) return
 * result`, which reads better than a chain when the failure type is uniform, so no
 * combinators are provided — a second dialect nobody uses is worse than none.
 */

import type { DeploymentError } from "./errors";

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

/** Defaults to `DeploymentError` because that is what the domain always fails with. */
export type Result<T, E = DeploymentError> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/**
 * Convert an error back into a thrown exception.
 *
 * Legitimate at a boundary where a failure is genuinely unrecoverable — a test
 * fixture, or startup of a process that must not continue misconfigured. Never
 * inside the domain, and never to avoid handling a failure that has a handler.
 */
export function unwrapOrThrow<T, E>(result: Result<T, E>): T {
  if (result.ok) {
    return result.value;
  }
  throw result.error instanceof Error ? result.error : new Error(String(result.error));
}
