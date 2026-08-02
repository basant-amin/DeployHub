/**
 * Per-step records.
 *
 * The steps of `docs/architecture/deployment-flow.md`, and what happened in
 * each. A record is a discriminated union on `status`, so "finished" and "has a
 * finish time" cannot disagree: a running step has no `finishedAt` field to be
 * wrong, and a failed step cannot exist without an error.
 *
 * Note that a step's *properties* — timeout, idempotency, compensation — are not
 * here. Those belong to the engine's step definitions; this is the record of a run.
 */

import { type Result, DeploymentError, Duration, Timestamp, err, ok } from "@/core/shared";

export const STEP_NAMES = [
  "preflight",
  "acquire_lock",
  "capture_baseline",
  "update_source",
  "build",
  "start_candidate",
  "health_check",
  "promote",
  "verify_route",
  // Restoring the previous release has its own group because it is the output a reader
  // most needs to find when a deployment goes wrong, and burying it in `start_candidate`
  // would mix "we tried to start this" with "we put the old one back".
  "rollback",
  "finalize",
  "release_lock",
] as const;

export type StepName = (typeof STEP_NAMES)[number];

export function isStepName(value: unknown): value is StepName {
  return typeof value === "string" && (STEP_NAMES as readonly string[]).includes(value);
}

export interface RunningStep {
  readonly status: "running";
  readonly name: StepName;
  readonly startedAt: Timestamp;
  /** Starts at 1. Incremented by a retry, never reset. */
  readonly attempts: number;
}

export interface SucceededStep {
  readonly status: "succeeded";
  readonly name: StepName;
  readonly startedAt: Timestamp;
  readonly finishedAt: Timestamp;
  readonly attempts: number;
  readonly duration: Duration;
}

export interface FailedStep {
  readonly status: "failed";
  readonly name: StepName;
  readonly startedAt: Timestamp;
  readonly finishedAt: Timestamp;
  readonly attempts: number;
  readonly duration: Duration;
  readonly error: DeploymentError;
}

/**
 * A step the pipeline did not run: the build skipped because the image already
 * exists, or a compensation with nothing to undo. A skipped step is not a failure
 * and has no duration.
 */
export interface SkippedStep {
  readonly status: "skipped";
  readonly name: StepName;
  readonly at: Timestamp;
  readonly reason: string;
}

export type StepRecord = RunningStep | SucceededStep | FailedStep | SkippedStep;

export function isRunning(record: StepRecord): record is RunningStep {
  return record.status === "running";
}

/** Constructors. Every one that closes a record verifies time moved forward. */
export const StepRecords = {
  start(name: StepName, at: Timestamp): RunningStep {
    return Object.freeze({ status: "running", name, startedAt: at, attempts: 1 } as const);
  },

  /** A new attempt at the same step. The original start time is preserved. */
  retry(record: RunningStep): RunningStep {
    return Object.freeze({ ...record, attempts: record.attempts + 1 });
  },

  succeed(record: RunningStep, at: Timestamp): Result<SucceededStep> {
    const duration = at.since(record.startedAt);
    if (!duration.ok) {
      return err(
        DeploymentError.of(
          "STEP_RECORD_INVALID",
          `Step "${record.name}" cannot finish at ${at.toISOString()}, before it started at ${record.startedAt.toISOString()}`,
        ),
      );
    }
    return ok(
      Object.freeze({
        status: "succeeded",
        name: record.name,
        startedAt: record.startedAt,
        finishedAt: at,
        attempts: record.attempts,
        duration: duration.value,
      } as const),
    );
  },

  fail(record: RunningStep, at: Timestamp, error: DeploymentError): Result<FailedStep> {
    const duration = at.since(record.startedAt);
    if (!duration.ok) {
      return err(
        DeploymentError.of(
          "STEP_RECORD_INVALID",
          `Step "${record.name}" cannot fail at ${at.toISOString()}, before it started at ${record.startedAt.toISOString()}`,
        ),
      );
    }
    return ok(
      Object.freeze({
        status: "failed",
        name: record.name,
        startedAt: record.startedAt,
        finishedAt: at,
        attempts: record.attempts,
        duration: duration.value,
        error: error.step === undefined ? error.withStep(record.name) : error,
      } as const),
    );
  },

  skip(name: StepName, at: Timestamp, reason: string): SkippedStep {
    return Object.freeze({ status: "skipped", name, at, reason } as const);
  },
} as const;
