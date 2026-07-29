/**
 * Domain aggregate → read model.
 *
 * One place that knows how a `Deployment` becomes something renderable, so two screens
 * cannot disagree about what "duration" means.
 */

import type { Deployment, Release } from "@/core/domain";
import type { Project } from "@/core/domain";
import type { DeploymentLogLine } from "@/core/ports";

import type {
  DeploymentDetail,
  DeploymentSummary,
  LogLineView,
  ProjectOverview,
  RollbackTarget,
  StepView,
  TimelineEntry,
  WarningView,
} from "../read-models";

export function toSummary(deployment: Deployment): DeploymentSummary {
  return {
    id: deployment.id,
    projectId: deployment.projectId,
    state: deployment.state,
    outcome: deployment.outcome,
    trigger: deployment.trigger,
    actor: deployment.actor,
    targetRef: deployment.targetRef,
    commitSha: deployment.resolvedSha,
    requestedAt: deployment.requestedAt.epochMillis,
    finishedAt: deployment.finishedAt?.epochMillis,
    durationMillis: deployment.totalDuration?.millis,
    errorCode: deployment.error?.code,
    errorMessage: deployment.error?.message,
    warningCount: deployment.warnings.length,
  };
}

export function toDetail(
  deployment: Deployment,
  logs: readonly DeploymentLogLine[],
): DeploymentDetail {
  return {
    ...toSummary(deployment),
    imageReference: deployment.image?.toString(),
    imageDigest: deployment.imageDigest,
    isFirstDeploy: deployment.isFirstDeploy,
    healthCheckPassedAt: deployment.healthCheckPassedAt?.epochMillis,
    routeVerifiedAt: deployment.routeVerifiedAt?.epochMillis,
    currentStep: deployment.currentStep,
    isActive: deployment.isActive,
    timeline: deployment.transitions.map((transition): TimelineEntry => ({
      state: transition.to,
      at: transition.at.epochMillis,
      reason: transition.reason,
    })),
    steps: deployment.steps.map((step): StepView => {
      if (step.status === "skipped") {
        return {
          name: step.name,
          status: "skipped",
          startedAt: step.at.epochMillis,
          finishedAt: step.at.epochMillis,
          durationMillis: 0,
          attempts: 0,
          errorMessage: step.reason,
        };
      }
      return {
        name: step.name,
        status: step.status,
        startedAt: step.startedAt.epochMillis,
        finishedAt: step.status === "running" ? undefined : step.finishedAt.epochMillis,
        durationMillis: step.status === "running" ? undefined : step.duration.millis,
        attempts: step.attempts,
        errorMessage: step.status === "failed" ? step.error.message : undefined,
      };
    }),
    warnings: deployment.warnings.map((warning): WarningView => ({
      code: warning.code,
      message: warning.message,
      step: warning.step,
      at: warning.at.epochMillis,
    })),
    logs: logs.map((line): LogLineView => ({
      at: line.at.epochMillis,
      step: line.step,
      stream: line.stream,
      text: line.text,
    })),
  };
}

export function toProjectOverview(input: {
  readonly project: Project;
  readonly liveRelease: Release | undefined;
  /** The release before the live one, if there is one. */
  readonly previousRelease: Release | undefined;
  readonly activeDeployment: Deployment | undefined;
}): ProjectOverview {
  const { project, liveRelease, previousRelease, activeDeployment } = input;
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    enabled: project.enabled,
    repositoryUrl: project.config.repositoryUrl,
    targetRef: project.config.targetRef,
    route: project.config.route.toString(),
    healthCheckPath: project.config.healthCheck.path,
    liveCommitSha: liveRelease?.commitSha,
    liveReleaseId: liveRelease?.id,
    liveSince: liveRelease?.deployedAt.epochMillis,
    activeDeploymentId: activeDeployment?.id,
    rollbackTarget: toRollbackTarget(previousRelease),
  };
}

function toRollbackTarget(release: Release | undefined): RollbackTarget | undefined {
  return release === undefined
    ? undefined
    : {
        releaseId: release.id,
        commitSha: release.commitSha,
        deployedAt: release.deployedAt.epochMillis,
      };
}
