/**
 * `GetDeploymentHistory` — the dashboard's home screen.
 *
 * Returns the project overview card and the deployment list in one call, because the screen
 * renders them together and two round trips to answer one question is a worse default than
 * one slightly wider query.
 *
 * The overview carries `activeDeploymentId`, which is what lets the Deploy button disable
 * itself rather than offering an action the platform will refuse.
 */

import { type ProjectId, type Result, DeploymentError, err, ok } from "@/core/shared";
import type { DeploymentRepository, ProjectRepository, ReleaseRepository } from "@/core/ports";

import type { DeploymentSummary, ProjectOverview } from "../read-models";
import { toProjectOverview, toSummary } from "./mappers";

export interface GetDeploymentHistoryPorts {
  readonly projects: ProjectRepository;
  readonly deployments: DeploymentRepository;
  readonly releases: ReleaseRepository;
}

export interface GetDeploymentHistoryInput {
  readonly projectId: ProjectId;
  /** Newest first. The dashboard shows a page, not the archive. */
  readonly limit?: number;
}

export interface DeploymentHistory {
  readonly project: ProjectOverview;
  readonly deployments: readonly DeploymentSummary[];
}

const DEFAULT_LIMIT = 20;

export class GetDeploymentHistory {
  constructor(private readonly ports: GetDeploymentHistoryPorts) {}

  async execute(input: GetDeploymentHistoryInput): Promise<Result<DeploymentHistory>> {
    const project = await this.ports.projects.findById(input.projectId);
    if (!project.ok) {
      return project;
    }
    if (project.value === undefined) {
      return err(
        DeploymentError.of("PROJECT_NOT_FOUND", `Project ${input.projectId} does not exist`, {
          details: { projectId: input.projectId },
        }),
      );
    }

    const deployments = await this.ports.deployments.listForProject(
      input.projectId,
      input.limit ?? DEFAULT_LIMIT,
    );
    if (!deployments.ok) {
      return deployments;
    }

    // Two in one query: the newest release is live, the one behind it is what a rollback returns
    // to. Asking for "live" and then "previous" separately would be two round trips for one fact.
    const releases = await this.ports.releases.listForProject(input.projectId, 2);
    if (!releases.ok) {
      return releases;
    }

    const active = await this.ports.deployments.findActiveForProject(input.projectId);
    if (!active.ok) {
      return active;
    }

    return ok({
      project: toProjectOverview({
        project: project.value,
        liveRelease: releases.value[0],
        previousRelease: releases.value[1],
        activeDeployment: active.value,
      }),
      deployments: deployments.value.map(toSummary),
    });
  }
}
