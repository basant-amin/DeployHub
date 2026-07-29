/**
 * Read models — what the dashboard renders.
 *
 * Plain, fully serializable shapes of primitives. Use cases return these rather than
 * domain aggregates for two reasons, and the second one is the load-bearing one:
 *
 * 1. A `Deployment` is a class with private state and methods. Rendering it would invite a
 *    component to call a lifecycle method, which is not the UI's business.
 * 2. The UI runs across a server/client boundary that only passes plain data. Handing a
 *    class instance across it fails at runtime, not at compile time.
 *
 * Timestamps are epoch milliseconds and durations are milliseconds — the two things every
 * renderer can format, with no assumption about the viewer's locale or timezone baked in
 * at this layer.
 */

import type {
  DeploymentOutcome,
  DeploymentState,
  DeploymentTrigger,
  StepName,
} from "@/core/domain";

/** One row in the deployment history. Everything a list needs and nothing more. */
export interface DeploymentSummary {
  readonly id: string;
  readonly projectId: string;
  readonly state: DeploymentState;
  readonly outcome: DeploymentOutcome | undefined;
  readonly trigger: DeploymentTrigger;
  readonly actor: string;
  /** What was asked for — a branch, a tag, or a sha on a rollback. */
  readonly targetRef: string;
  /** What it resolved to, once known. */
  readonly commitSha: string | undefined;
  readonly requestedAt: number;
  readonly finishedAt: number | undefined;
  readonly durationMillis: number | undefined;
  /** Present on any deployment that did not succeed. */
  readonly errorCode: string | undefined;
  readonly errorMessage: string | undefined;
  readonly warningCount: number;
}

/** One entry in the deployment timeline. */
export interface TimelineEntry {
  readonly state: DeploymentState;
  readonly at: number;
  readonly reason: string | undefined;
}

/** One step's record, for the step list beside the timeline. */
export interface StepView {
  readonly name: StepName;
  readonly status: "running" | "succeeded" | "failed" | "skipped";
  readonly startedAt: number;
  readonly finishedAt: number | undefined;
  readonly durationMillis: number | undefined;
  readonly attempts: number;
  readonly errorMessage: string | undefined;
}

export interface WarningView {
  readonly code: string;
  readonly message: string;
  readonly step: StepName | undefined;
  readonly at: number;
}

export interface LogLineView {
  readonly at: number;
  readonly step: StepName;
  readonly stream: "stdout" | "stderr" | "system";
  readonly text: string;
}

/** Everything the deployment detail screen shows. */
export interface DeploymentDetail extends DeploymentSummary {
  readonly imageReference: string | undefined;
  readonly imageDigest: string | undefined;
  readonly isFirstDeploy: boolean;
  readonly healthCheckPassedAt: number | undefined;
  readonly routeVerifiedAt: number | undefined;
  readonly currentStep: StepName | undefined;
  /** Whether this deployment is still moving. Drives whether the UI keeps polling. */
  readonly isActive: boolean;
  readonly timeline: readonly TimelineEntry[];
  readonly steps: readonly StepView[];
  readonly warnings: readonly WarningView[];
  readonly logs: readonly LogLineView[];
}

/** The project overview card. */
export interface ProjectOverview {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly enabled: boolean;
  readonly repositoryUrl: string;
  readonly targetRef: string;
  readonly route: string;
  readonly healthCheckPath: string;
  /** The commit currently serving traffic, if anything is. */
  readonly liveCommitSha: string | undefined;
  readonly liveReleaseId: string | undefined;
  readonly liveSince: number | undefined;
  /** Set when a deployment is in flight, so the Deploy button can disable itself. */
  readonly activeDeploymentId: string | undefined;
  /**
   * The release one click would return to — the one before the live one.
   *
   * Pre-computed so the rollback affordance can name its destination. An escape hatch you have to
   * go looking for while stressed is not an escape hatch.
   */
  readonly rollbackTarget: RollbackTarget | undefined;
}

export interface RollbackTarget {
  readonly releaseId: string;
  readonly commitSha: string;
  readonly deployedAt: number;
}
