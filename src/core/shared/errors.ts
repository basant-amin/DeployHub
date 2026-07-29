/**
 * `DeploymentError` — the one error type the platform reports.
 *
 * Every failure carries a stable machine-readable `code`, the `errorClass` derived
 * from it, and enough structured context to explain itself without anyone grepping
 * a log file. This is what lets the UI render "the health check failed" instead of
 * "something went wrong, see logs".
 */

import { type ErrorClass, type ErrorCode, errorClassOf } from "./error-codes";

export interface DeploymentErrorOptions {
  /**
   * Field-level or check-level issues behind a single failure. Populated when
   * validating a composite (a `DeployConfig` reports every bad field at once).
   */
  readonly issues?: readonly string[];
  /**
   * The deployment step this failure occurred in.
   *
   * Typed as `string` because the shared kernel sits below the domain and cannot
   * import `StepName`. Callers pass a `StepName`, which is assignable; readers that
   * need the narrow type validate it rather than casting.
   */
  readonly step?: string;
  /** Structured context for the UI and for log correlation. Must not hold secrets. */
  readonly details?: Readonly<Record<string, unknown>>;
}

/** The wire/storage shape. Stable alongside the code catalog. */
export interface SerializedDeploymentError {
  readonly name: "DeploymentError";
  readonly code: ErrorCode;
  readonly errorClass: ErrorClass;
  readonly message: string;
  readonly issues: readonly string[];
  readonly step?: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export class DeploymentError extends Error {
  override readonly name = "DeploymentError";
  readonly code: ErrorCode;
  readonly errorClass: ErrorClass;
  readonly issues: readonly string[];
  readonly step: string | undefined;
  readonly details: Readonly<Record<string, unknown>>;

  private constructor(code: ErrorCode, message: string, options: DeploymentErrorOptions) {
    super(message);
    this.code = code;
    this.errorClass = errorClassOf(code);
    this.issues = Object.freeze([...(options.issues ?? [])]);
    this.step = options.step;
    this.details = Object.freeze({ ...options.details });
  }

  /**
   * The only constructor. The class is never passed in — it is derived from the
   * code, so a code cannot be raised as the wrong class.
   */
  static of(
    code: ErrorCode,
    message: string,
    options: DeploymentErrorOptions = {},
  ): DeploymentError {
    return new DeploymentError(code, message, options);
  }

  /**
   * A validation failure carrying every issue found, with the issue list appended
   * to the message so a plain-text rendering is still useful.
   */
  static validation(
    code: ErrorCode,
    message: string,
    issues: readonly string[],
    details?: Readonly<Record<string, unknown>>,
  ): DeploymentError {
    const summary = issues.length > 0 ? `${message}: ${issues.join("; ")}` : message;
    return new DeploymentError(code, summary, {
      issues,
      ...(details === undefined ? {} : { details }),
    });
  }

  /** Attach the failing step. Returns a copy; errors are immutable. */
  withStep(step: string): DeploymentError {
    return new DeploymentError(this.code, this.message, {
      issues: this.issues,
      step,
      details: this.details,
    });
  }

  toJSON(): SerializedDeploymentError {
    return {
      name: this.name,
      code: this.code,
      errorClass: this.errorClass,
      message: this.message,
      issues: this.issues,
      ...(this.step === undefined ? {} : { step: this.step }),
      details: this.details,
    };
  }
}
