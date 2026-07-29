/**
 * `RequestDeployment` — admission.
 *
 * Runs in the request that handles the click, so it must be fast and must not touch the
 * server being deployed to. It validates, deduplicates, refuses a busy project, persists a
 * queued deployment, and returns. The worker does the rest.
 *
 * The order of the checks is the order of their cost and their bluntness. A disabled
 * project is refused before a lookup for a replayed key, which is refused before a scan for
 * an in-flight deployment, so the reported reason is always the most fundamental one that
 * applies.
 */

import {
  type Actor,
  type GitRef,
  type IdempotencyKey,
  type ProjectId,
  type Result,
  DeploymentError,
  err,
  ok,
} from "@/core/shared";
import { type Project, Deployment, ensureNoActiveDeployment } from "@/core/domain";
import type { Clock, DeploymentRepository, IdGenerator, ProjectRepository } from "@/core/ports";

import { type DeploymentSummary } from "../read-models";
import { toSummary } from "./mappers";

export interface RequestDeploymentPorts {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly projects: ProjectRepository;
  readonly deployments: DeploymentRepository;
}

export interface RequestDeploymentInput {
  readonly projectId: ProjectId;
  readonly actor: Actor;
  /**
   * One key per intent, generated per click. Replaying it returns the original deployment
   * rather than starting a second one — which is what makes a double-clicked Deploy button
   * harmless instead of a race for the lock.
   */
  readonly idempotencyKey: IdempotencyKey;
  /** Overrides the project's configured ref. Omit for the normal case. */
  readonly targetRef?: GitRef;
}

export interface RequestDeploymentResult {
  readonly deployment: DeploymentSummary;
  /** True when the key had been seen before and no new deployment was created. */
  readonly deduplicated: boolean;
}

export class RequestDeployment {
  constructor(private readonly ports: RequestDeploymentPorts) {}

  async execute(input: RequestDeploymentInput): Promise<Result<RequestDeploymentResult>> {
    const project = await this.loadDeployableProject(input.projectId);
    if (!project.ok) {
      return project;
    }

    const replayed = await this.ports.deployments.findByIdempotencyKey(
      input.projectId,
      input.idempotencyKey,
    );
    if (!replayed.ok) {
      return replayed;
    }
    if (replayed.value !== undefined) {
      return ok({ deployment: toSummary(replayed.value), deduplicated: true });
    }

    // Invariant 1. The unique constraint behind `save` is what makes this correct under a
    // race; this check is what makes the refusal explicable.
    const active = await this.ports.deployments.findActiveForProject(input.projectId);
    if (!active.ok) {
      return active;
    }
    const admitted = ensureNoActiveDeployment(active.value === undefined ? [] : [active.value]);
    if (!admitted.ok) {
      return admitted;
    }

    const deployment = Deployment.request({
      id: this.ports.ids.nextDeploymentId(),
      projectId: project.value.id,
      trigger: "manual",
      actor: input.actor,
      targetRef: input.targetRef ?? project.value.config.targetRef,
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

    return ok({ deployment: toSummary(deployment.value), deduplicated: false });
  }

  private async loadDeployableProject(id: ProjectId): Promise<Result<Project>> {
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
    return found.value.ensureDeployable();
  }
}
