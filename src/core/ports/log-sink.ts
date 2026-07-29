/**
 * `DeploymentLogSink` — durable, append-only, streamable deployment logs.
 *
 * The lifecycle is `open`, then `append` many times, then `complete`. `open` takes the
 * `Redactor` built from the secrets resolved for that deployment, and that is the whole
 * reason the lifecycle exists: redaction is applied **once, in the sink**, so no adapter
 * can leak a credential by forgetting to call it. A dozen places write log lines; one
 * place stores them.
 *
 * Logs are diagnostic artifacts, never the source of truth for status. A UI that infers
 * "succeeded" from log text is reading the wrong thing — the deployment record says what
 * happened. A failed log write is therefore a warning on that record, never a failed
 * deployment.
 */

import type { DeploymentId, Redactor, Result, Timestamp } from "@/core/shared";
import type { StepName } from "@/core/domain";

/** Which stream a line came from. `system` is the platform narrating its own steps. */
export type LogStream = "stdout" | "stderr" | "system";

export interface DeploymentLogLine {
  readonly at: Timestamp;
  /** The step that produced it, so a reader can collapse the log by phase. */
  readonly step: StepName;
  readonly stream: LogStream;
  readonly text: string;
}

export interface DeploymentLogSink {
  /**
   * Begin a deployment's log, bound to the redactor for its resolved secrets.
   *
   * Every line appended afterwards passes through that redactor. Calling `append`
   * without having opened the log is an error rather than an unredacted write.
   */
  open(deploymentId: DeploymentId, redactor: Redactor): Promise<Result<void>>;

  /** Append one line. Redacted by the sink, never by the caller. */
  append(deploymentId: DeploymentId, line: DeploymentLogLine): Promise<Result<void>>;

  /** Mark the artifact finished. No further appends are accepted. */
  complete(deploymentId: DeploymentId): Promise<Result<void>>;

  /** The whole log of a finished deployment. */
  read(deploymentId: DeploymentId): Promise<Result<readonly DeploymentLogLine[]>>;

  /**
   * Historical lines followed by live ones, ending when the log is completed.
   *
   * What the log viewer subscribes to while a deployment runs. An `AsyncIterable` rather
   * than a callback so the consumer controls back-pressure and can simply stop reading.
   */
  tail(deploymentId: DeploymentId): AsyncIterable<DeploymentLogLine>;
}
