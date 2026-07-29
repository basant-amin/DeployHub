/**
 * Persistence ports.
 *
 * Three repositories, one per aggregate, each speaking only in domain objects. A
 * repository returns a `Project`, a `Deployment`, or a `Release` — never a row, never
 * an ORM entity, and never a partially-assembled object. Reconstitution goes through
 * `Deployment.rehydrate`, so a record that has drifted out of a legal shape is
 * rejected at the boundary rather than resumed.
 *
 * "Not found" is modelled as `undefined` inside a successful `Result`, not as a
 * failure: asking for a deployment that does not exist is a normal query outcome,
 * while a failed `Result` means the store could not answer.
 *
 * There is no queue port. Release 1 rejects concurrent deploys rather than queueing
 * them (`docs/architecture/decisions.md` § D6), so the worker's entire coordination
 * need is "give me the deployments that have not started yet" — a query, satisfied
 * here.
 */

import type { DeploymentId, IdempotencyKey, ProjectId, ReleaseId, Result } from "@/core/shared";
import type { Deployment, Project, Release } from "@/core/domain";

export interface ProjectRepository {
  findById(id: ProjectId): Promise<Result<Project | undefined>>;

  /** Every configured project. Release 1 has one; the projects screen still lists. */
  list(): Promise<Result<readonly Project[]>>;

  /** Insert or replace. The aggregate is immutable, so this is a whole-object write. */
  save(project: Project): Promise<Result<void>>;
}

export interface DeploymentRepository {
  /**
   * Insert or replace.
   *
   * The store is expected to enforce, as constraints, the two invariants a check
   * alone cannot close against a race: at most one non-terminal deployment per
   * project, and one deployment per idempotency key. The use case checks both first to
   * produce a good error message; the constraint is what makes it correct.
   */
  save(deployment: Deployment): Promise<Result<void>>;

  findById(id: DeploymentId): Promise<Result<Deployment | undefined>>;

  /** Admission dedupe: a replayed key returns the original deployment. */
  findByIdempotencyKey(
    projectId: ProjectId,
    key: IdempotencyKey,
  ): Promise<Result<Deployment | undefined>>;

  /** Invariant 1 at admission: the project's in-flight deployment, if any. */
  findActiveForProject(projectId: ProjectId): Promise<Result<Deployment | undefined>>;

  /** Work waiting to start, oldest first. The worker's only source of work. */
  findQueued(limit: number): Promise<Result<readonly Deployment[]>>;

  /**
   * Every deployment in a non-terminal state, across all projects.
   *
   * The reconciler's starting point: it cross-references these against the lock's
   * expired leases to find deployments whose worker died.
   */
  findUnfinished(): Promise<Result<readonly Deployment[]>>;

  /** Deployment history for a project, newest first. */
  listForProject(projectId: ProjectId, limit: number): Promise<Result<readonly Deployment[]>>;

  /**
   * Record that an operator asked for this deployment to stop.
   *
   * Cancellation is a flag rather than a signal because the worker that must honour it
   * is not the process that received the request — it may not even be the same
   * machine. The flag is durable; the engine reads it at step boundaries.
   */
  requestCancellation(id: DeploymentId): Promise<Result<void>>;

  isCancellationRequested(id: DeploymentId): Promise<Result<boolean>>;
}

export interface ReleaseRepository {
  save(release: Release): Promise<Result<void>>;

  findById(id: ReleaseId): Promise<Result<Release | undefined>>;

  /**
   * The release currently serving traffic, or `undefined` before the first deploy.
   *
   * Needed for rollback eligibility, which refuses a target that is already live.
   */
  findLiveForProject(projectId: ProjectId): Promise<Result<Release | undefined>>;

  /**
   * Releases for a project, newest first.
   *
   * Serves both the rollback picker and image retention: the engine keeps the newest
   * `imageRetention` releases' digests and asks the container runtime to remove the
   * rest.
   */
  listForProject(projectId: ProjectId, limit: number): Promise<Result<readonly Release[]>>;
}
