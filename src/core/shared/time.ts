/**
 * Time value objects.
 *
 * The domain never reads the clock. Every method that needs "now" takes a
 * `Timestamp` parameter, and the only thing that may produce one from the actual
 * system clock is the `Clock` port. That is the difference between a state machine
 * whose timing rules can be tested exhaustively in microseconds and one that needs
 * fake timers to test at all.
 */

import { DeploymentError } from "./errors";
import { type Result, err, ok } from "./result";
import { parseInteger } from "./validation";

/** ECMAScript's maximum representable date, ±8.64e15 ms from the epoch. */
const MAX_EPOCH_MILLIS = 8_640_000_000_000_000;

/** A non-negative span of time, in whole milliseconds. */
export class Duration {
  private constructor(readonly millis: number) {}

  static fromMillis(raw: unknown): Result<Duration> {
    const parsed = parseInteger(raw, {
      label: "Duration in milliseconds",
      code: "DURATION_INVALID",
      min: 0,
      max: MAX_EPOCH_MILLIS,
    });
    return parsed.ok ? ok(new Duration(parsed.value)) : parsed;
  }

  /**
   * Scale by a non-negative integer count.
   *
   * Returns a `Duration`, not a `Result`: callers multiply a bounded interval by a
   * bounded repeat count, so there is no reachable overflow to report, and returning
   * one would only invite a swallowed failure at the call site.
   */
  times(count: number): Duration {
    return new Duration(this.millis * Math.max(0, Math.trunc(count)));
  }

  isLongerThan(other: Duration): boolean {
    return this.millis > other.millis;
  }

  isShorterThan(other: Duration): boolean {
    return this.millis < other.millis;
  }

  equals(other: Duration): boolean {
    return this.millis === other.millis;
  }
}

/** An instant, as whole milliseconds since the Unix epoch. */
export class Timestamp {
  private constructor(readonly epochMillis: number) {}

  static fromEpochMillis(raw: unknown): Result<Timestamp> {
    const parsed = parseInteger(raw, {
      label: "Timestamp",
      code: "TIMESTAMP_INVALID",
      min: 0,
      max: MAX_EPOCH_MILLIS,
    });
    return parsed.ok ? ok(new Timestamp(parsed.value)) : parsed;
  }

  /** The later of two instants. */
  static max(a: Timestamp, b: Timestamp): Timestamp {
    return a.epochMillis >= b.epochMillis ? a : b;
  }

  /**
   * Elapsed time from `earlier` to this instant. Fails when `earlier` is later —
   * a negative duration is not representable, which is how time going backwards
   * becomes a caught error instead of a nonsensical number.
   */
  since(earlier: Timestamp): Result<Duration> {
    if (this.epochMillis < earlier.epochMillis) {
      return err(
        DeploymentError.of(
          "NON_MONOTONIC_TIMESTAMP",
          `Cannot measure elapsed time: ${this.toISOString()} precedes ${earlier.toISOString()}`,
        ),
      );
    }
    return Duration.fromMillis(this.epochMillis - earlier.epochMillis);
  }

  isBefore(other: Timestamp): boolean {
    return this.epochMillis < other.epochMillis;
  }

  equals(other: Timestamp): boolean {
    return this.epochMillis === other.epochMillis;
  }

  /** For error messages and log lines. Formatting for display is not domain work. */
  toISOString(): string {
    return new Date(this.epochMillis).toISOString();
  }
}
