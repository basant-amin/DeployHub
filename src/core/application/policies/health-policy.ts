/**
 * Health evaluation — the decision the probe adapter is forbidden to make.
 *
 * A pure function over the attempts so far. That is the whole reason it is here rather
 * than in the adapter: the awkward cases are the interesting ones, and they are trivial
 * to test as data. A service that flaps pass/fail/pass must not be promoted, and
 * asserting that takes three array entries rather than a mock HTTP server.
 *
 * The function decides; the engine acts. It returns "wait this long and probe again",
 * never sleeps.
 */

import { type Duration, unwrapOrThrow } from "@/core/shared";
import { Duration as DurationCodec } from "@/core/shared";
import type { HealthCheckSpec } from "@/core/domain";
import type { ProbeOutcome } from "@/core/ports";

export type HealthDecision =
  /** Enough consecutive passes. Promotion is now permitted. */
  | { readonly kind: "pass" }
  /** Not yet, and there is budget left. */
  | { readonly kind: "retry"; readonly waitFor: Duration }
  /** Out of budget, or the candidate is gone. Discard it. */
  | { readonly kind: "fail"; readonly reason: string };

export interface HealthEvaluation {
  readonly spec: HealthCheckSpec;
  /** Every attempt so far, oldest first. */
  readonly attempts: readonly ProbeOutcome[];
  /** Time spent probing, for comparison against the spec's total budget. */
  readonly elapsed: Duration;
}

/**
 * Count passes at the *end* of the run, not anywhere in it.
 *
 * `requiredConsecutivePasses` means consecutive: a single failure resets the count,
 * which is exactly what stops a flapping service from being promoted on the strength of
 * two good answers ten seconds apart.
 */
function trailingPasses(spec: HealthCheckSpec, attempts: readonly ProbeOutcome[]): number {
  let passes = 0;
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index];
    if (attempt === undefined || attempt.kind !== "responded" || !spec.accepts(attempt.status)) {
      break;
    }
    passes += 1;
  }
  return passes;
}

export function evaluateHealth(evaluation: HealthEvaluation): HealthDecision {
  const { spec, attempts, elapsed } = evaluation;

  const passes = trailingPasses(spec, attempts);
  if (passes >= spec.requiredConsecutivePasses) {
    return { kind: "pass" };
  }

  // Would the next attempt fall outside the budget? Comparing before waiting means the
  // engine never sleeps into a deadline it has already missed.
  if (elapsed.millis + spec.interval.millis > spec.totalBudget.millis) {
    return { kind: "fail", reason: describeFailure(spec, attempts, passes) };
  }

  return { kind: "retry", waitFor: spec.interval };
}

function describeFailure(
  spec: HealthCheckSpec,
  attempts: readonly ProbeOutcome[],
  passes: number,
): string {
  const last = attempts.at(-1);
  const budget = spec.totalBudget.millis;
  const summary =
    last === undefined
      ? "no probe was attempted"
      : last.kind === "responded"
        ? `last response was ${last.status}, expected ${spec.expectedStatus}`
        : `last attempt did not reach the container: ${last.reason}`;
  return `health check did not pass within ${budget}ms after ${attempts.length} attempt(s) (${passes}/${spec.requiredConsecutivePasses} consecutive passes): ${summary}`;
}

/** Zero elapsed time, for the first evaluation of a run. */
export const NO_TIME_ELAPSED: Duration = unwrapOrThrow(DurationCodec.fromMillis(0));
