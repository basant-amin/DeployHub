/**
 * `Clock` — the only thing permitted to read the current time.
 *
 * The domain layer takes every timestamp as a parameter and never reads a clock, which
 * is what makes its timing rules testable without fake timers. That guarantee only
 * holds if there is exactly one place the real time enters the system, and this is it.
 *
 * `sleep` lives here rather than in the engine because waiting is a side effect. The
 * retry policy decides *how long* to wait and returns a `Duration`; the engine asks
 * the clock to wait it. A policy that slept would be a policy that could not be
 * tested at speed.
 */

import type { Duration, Timestamp } from "@/core/shared";

export interface Clock {
  /** The current instant. Synchronous: reading a clock cannot fail or block. */
  now(): Timestamp;

  /**
   * Wait for the given duration.
   *
   * Rejects nothing and returns nothing — a wait that was cut short by process
   * shutdown is indistinguishable from one that completed, and the engine checks
   * cancellation at step boundaries regardless.
   */
  sleep(duration: Duration): Promise<void>;
}
