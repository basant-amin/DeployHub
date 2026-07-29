/**
 * `DeploymentWarning` — something went wrong that did not make the deployment fail.
 *
 * The architecture is explicit that a failed finalization step (a prune that could
 * not run, a log flush that failed) yields `succeeded` with warnings attached: the
 * release is live and verified, and calling that a failure would be wrong. A
 * best-effort compensation that itself failed is recorded the same way.
 *
 * Warnings are part of the deployment record, not log output. They survive, they are
 * queryable, and they are shown next to the outcome.
 */

import { type DeploymentError, type ErrorCode, Timestamp } from "@/core/shared";

import { type StepName, isStepName } from "./step";

export class DeploymentWarning {
  private constructor(
    readonly code: ErrorCode,
    readonly message: string,
    readonly at: Timestamp,
    readonly step: StepName | undefined,
  ) {}

  static create(
    code: ErrorCode,
    message: string,
    at: Timestamp,
    step?: StepName,
  ): DeploymentWarning {
    return new DeploymentWarning(code, message, at, step);
  }

  /**
   * Demote a caught error to a warning — the compensation/finalization path.
   *
   * The error's own `step` is typed as `string` (the shared kernel sits below the
   * domain and cannot import `StepName`), so it is *validated* here rather than cast:
   * an unrecognized value is dropped instead of being smuggled in as a `StepName`.
   */
  static fromError(error: DeploymentError, at: Timestamp, step?: StepName): DeploymentWarning {
    const fromError = isStepName(error.step) ? error.step : undefined;
    return new DeploymentWarning(error.code, error.message, at, step ?? fromError);
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return {
      code: this.code,
      message: this.message,
      at: this.at.epochMillis,
      ...(this.step === undefined ? {} : { step: this.step }),
    };
  }
}
