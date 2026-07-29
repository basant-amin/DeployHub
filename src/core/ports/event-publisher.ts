/**
 * `EventPublisher` — announce that something changed.
 *
 * Events are a notification that the deployment record moved, never the record itself.
 * The engine persists first and publishes second, so a dropped event costs a stale UI
 * until the next read and never costs correctness. Any port that could lose a message
 * is safe to use for exactly this reason.
 *
 * The event set is small on purpose. `state_changed` covers queued, succeeded, failed,
 * rolled back, and every other lifecycle moment, because in this design the state *is*
 * the event — enumerating ten named events would mean ten things to keep in step with
 * one state machine. Step events exist separately because they are more frequent than
 * state changes and carry timing.
 *
 * Notifications — Slack, email — are a named extension point implemented as a
 * subscriber, not as a second port.
 */

import type {
  DeploymentId,
  Duration,
  ErrorCode,
  ProjectId,
  Result,
  Timestamp,
} from "@/core/shared";
import type { DeploymentState, StepName } from "@/core/domain";

interface DeploymentEventBase {
  readonly deploymentId: DeploymentId;
  readonly projectId: ProjectId;
  readonly at: Timestamp;
}

export type DeploymentEvent =
  /** The deployment moved. Terminal states arrive as one of these too. */
  | (DeploymentEventBase & {
      readonly kind: "deployment.state_changed";
      readonly from: DeploymentState;
      readonly to: DeploymentState;
      /** Why, when there is a reason worth showing: an error code or an operator note. */
      readonly reason: string | undefined;
    })
  | (DeploymentEventBase & {
      readonly kind: "deployment.step_started";
      readonly step: StepName;
      readonly attempt: number;
    })
  | (DeploymentEventBase & {
      readonly kind: "deployment.step_finished";
      readonly step: StepName;
      readonly status: "succeeded" | "failed" | "skipped";
      readonly duration: Duration;
    })
  /** Something went wrong that did not fail the deployment. Shown beside the outcome. */
  | (DeploymentEventBase & {
      readonly kind: "deployment.warning";
      readonly code: ErrorCode;
      readonly message: string;
    });

export interface EventPublisher {
  /**
   * Publish one event.
   *
   * Fails only when the event could not be handed off. Callers treat a failure as a
   * warning on the deployment, never as a reason to fail it: the database has already
   * recorded what happened.
   */
  publish(event: DeploymentEvent): Promise<Result<void>>;
}
