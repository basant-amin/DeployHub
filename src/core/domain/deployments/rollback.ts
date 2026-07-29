/**
 * Rollback eligibility.
 *
 * Rolling back is not a special mechanism — it is a deployment of an older commit,
 * run through the same pipeline (`docs/architecture/decisions.md` § D5). What is
 * special is *deciding whether a given release is a legitimate target*, and that
 * decision is a domain rule, not a UI concern: a button that offers an ineligible
 * rollback and fails on click is worse than one that explains why it is disabled.
 *
 * The result is a discriminated union rather than a boolean, so every refusal carries
 * a reason the interface can render. There is deliberately no `Result`-returning
 * variant alongside it: two APIs for one rule means two places to keep in step, and
 * mapping a refusal to an error is the caller's job.
 */

import type { Project } from "../projects";
import type { Release } from "./release";

export type RollbackRefusalReason =
  /** The project is disabled; it accepts no deployments at all. */
  | "project_disabled"
  /** The release belongs to a different project. */
  | "release_project_mismatch"
  /** Another deployment is already running for this project. */
  | "deployment_in_progress"
  /** The target release is the one already serving traffic. */
  | "already_live"
  /** The target ships the same commit that is already live. */
  | "same_commit_as_live";

export interface RollbackEligible {
  readonly eligible: true;
  readonly target: Release;
}

export interface RollbackRefused {
  readonly eligible: false;
  readonly reason: RollbackRefusalReason;
  readonly explanation: string;
}

export type RollbackEligibility = RollbackEligible | RollbackRefused;

export interface RollbackAssessment {
  readonly project: Project;
  /** The release to roll back to. */
  readonly target: Release;
  /** The release currently serving traffic, or `undefined` if none is recorded. */
  readonly liveRelease: Release | undefined;
  /**
   * Whether the project has a deployment in a non-terminal state. Supplied by the
   * caller: the aggregate cannot see other records, and the domain must not query.
   */
  readonly hasActiveDeployment: boolean;
}

/**
 * Assess a rollback target.
 *
 * Ordered from most fundamental to most specific, so the reason reported is the most
 * useful one: "the project is disabled" explains more than "the commit is already
 * live" when both are true.
 */
export function assessRollback(assessment: RollbackAssessment): RollbackEligibility {
  const { project, target, liveRelease, hasActiveDeployment } = assessment;

  if (!project.isDeployable) {
    return refuse(
      "project_disabled",
      `Project "${project.slug}" is disabled and cannot be deployed`,
    );
  }

  if (target.projectId !== project.id) {
    return refuse(
      "release_project_mismatch",
      `Release ${target.id} belongs to project ${target.projectId}, not ${project.id}`,
    );
  }

  if (hasActiveDeployment) {
    return refuse(
      "deployment_in_progress",
      `Project "${project.slug}" already has a deployment in progress`,
    );
  }

  if (liveRelease !== undefined) {
    if (liveRelease.equals(target)) {
      return refuse("already_live", `Release ${target.id} is already the live release`);
    }
    if (liveRelease.hasSameCommit(target)) {
      return refuse(
        "same_commit_as_live",
        `Release ${target.id} ships commit ${target.commitSha}, which is already live`,
      );
    }
  }

  return { eligible: true, target };
}

function refuse(reason: RollbackRefusalReason, explanation: string): RollbackRefused {
  return { eligible: false, reason, explanation };
}
