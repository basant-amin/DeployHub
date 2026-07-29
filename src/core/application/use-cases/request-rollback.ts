/**
 * `RequestRollback` — deploy an older release again.
 *
 * There is no rollback pipeline. This use case resolves a target release, asks the domain
 * whether it is a legitimate one, and then queues an ordinary deployment whose target ref is
 * that release's commit sha. The engine runs it exactly like any other deploy, so a rollback
 * is validated, locked, health-checked, and verified through the public route — rather than
 * taking a shortcut through the one code path nobody exercises until an incident
 * (`docs/architecture/decisions.md` § D5).
 *
 * A commit sha is a valid `GitRef`, which is what makes this possible without a second
 * mechanism.
 */

import {
  type Actor,
  type IdempotencyKey,
  type ProjectId,
  type ReleaseId,
  type Result,
  DeploymentError,
  GitRef,
  err,
  ok,
} from "@/core/shared";
import { type Project, type Release, Deployment, assessRollback } from "@/core/domain";
import type {
  Clock,
  DeploymentRepository,
  IdGenerator,
  ProjectRepository,
  ReleaseRepository,
} from "@/core/ports";

import type { DeploymentSummary } from "../read-models";
import { toSummary } from "./mappers";

export interface RequestRollbackPorts {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly projects: ProjectRepository;
  readonly deployments: DeploymentRepository;
  readonly releases: ReleaseRepository;
}

export interface RequestRollbackInput {
  readonly projectId: ProjectId;
  /** The release to return to. */
  readonly releaseId: ReleaseId;
  readonly actor: Actor;
  readonly idempotencyKey: IdempotencyKey;
}

export class RequestRollback {
  constructor(private readonly ports: RequestRollbackPorts) {}

  async execute(input: RequestRollbackInput): Promise<Result<DeploymentSummary>> {
    const project = await this.loadProject(input.projectId);
    if (!project.ok) {
      return project;
    }

    const target = await this.loadRelease(input.releaseId);
    if (!target.ok) {
      return target;
    }

    const liveRelease = await this.ports.releases.findLiveForProject(input.projectId);
    if (!liveRelease.ok) {
      return liveRelease;
    }

    const active = await this.ports.deployments.findActiveForProject(input.projectId);
    if (!active.ok) {
      return active;
    }

    const eligibility = assessRollback({
      project: project.value,
      target: target.value,
      liveRelease: liveRelease.value,
      hasActiveDeployment: active.value !== undefined,
    });
    if (!eligibility.eligible) {
      return err(
        DeploymentError.of("ROLLBACK_NOT_ELIGIBLE", eligibility.explanation, {
          details: {
            reason: eligibility.reason,
            projectId: input.projectId,
            releaseId: input.releaseId,
          },
        }),
      );
    }

    // The sha, not the branch: a rollback must land on exactly the commit that shipped.
    const targetRef = GitRef.parse(target.value.commitSha);
    if (!targetRef.ok) {
      return targetRef;
    }

    const deployment = Deployment.request({
      id: this.ports.ids.nextDeploymentId(),
      projectId: project.value.id,
      trigger: "rollback",
      actor: input.actor,
      targetRef: targetRef.value,
      idempotencyKey: input.idempotencyKey,
      requestedAt: this.ports.clock.now(),
    });
    if (!deployment.ok) {
      return deployment;
    }

    const saved = await this.ports.deployments.save(deployment.value);
    if (!saved.ok) {
      return saved;
    }

    return ok(toSummary(deployment.value));
  }

  private async loadProject(id: ProjectId): Promise<Result<Project>> {
    const found = await this.ports.projects.findById(id);
    if (!found.ok) {
      return found;
    }
    if (found.value === undefined) {
      return err(
        DeploymentError.of("PROJECT_NOT_FOUND", `Project ${id} does not exist`, {
          details: { projectId: id },
        }),
      );
    }
    return ok(found.value);
  }

  private async loadRelease(id: ReleaseId): Promise<Result<Release>> {
    const found = await this.ports.releases.findById(id);
    if (!found.ok) {
      return found;
    }
    if (found.value === undefined) {
      return err(
        DeploymentError.of("RELEASE_NOT_FOUND", `Release ${id} does not exist`, {
          details: { releaseId: id },
        }),
      );
    }
    return ok(found.value);
  }
}
