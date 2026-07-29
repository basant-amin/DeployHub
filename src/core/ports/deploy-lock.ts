/**
 * `DeployLock` — single writer per project, crash-safe and fenced.
 *
 * The port exposes a **lease**, not a mutex. That is the whole design in one word: a
 * mutex is held by a live process and dies with it, leaving the half-finished
 * container it was protecting behind, while a lease expires on its own and can
 * therefore be recovered from. Every acquisition returns a `LockEpoch` — the fencing
 * token — and every subsequent operation presents the lease it was given, so a worker
 * that stalled past its expiry cannot act on a server that now belongs to someone
 * else.
 *
 * Acquisition never waits. It succeeds now or fails now, because release 1 rejects a
 * busy project rather than queueing behind it
 * (`docs/architecture/decisions.md` § D6).
 *
 * How the lease is stored, and whether it is paired with an advisory lock on the
 * target host, is the adapter's business. The engine's need is exactly the four
 * operations below.
 */

import type { Brand, DeploymentId, LockEpoch, ProjectId, Result, Timestamp } from "@/core/shared";

/**
 * Identifies the worker instance holding a lease.
 *
 * Branded but unparsed: the runtime mints it from its own process identity, so it
 * never arrives as untrusted input and needs no validating codec.
 */
export type WorkerId = Brand<string, "WorkerId">;

/** A granted lease. Present it back to renew or release; never construct one. */
export interface DeployLease {
  readonly projectId: ProjectId;
  readonly deploymentId: DeploymentId;
  readonly holder: WorkerId;
  /** The fencing token. Increases on every takeover of an expired lease. */
  readonly epoch: LockEpoch;
  readonly acquiredAt: Timestamp;
  /** After this instant the lease is recoverable by another worker. */
  readonly expiresAt: Timestamp;
}

export interface AcquireLeaseRequest {
  readonly projectId: ProjectId;
  readonly deploymentId: DeploymentId;
  readonly holder: WorkerId;
}

export interface DeployLock {
  /**
   * Take the project's lease, or fail because someone else holds an unexpired one.
   *
   * Must be a single atomic operation — insert-if-absent, or take over if expired —
   * so that two workers racing produce exactly one winner. A check followed by a write
   * is not an implementation of this method.
   */
  acquire(request: AcquireLeaseRequest): Promise<Result<DeployLease>>;

  /**
   * Extend the lease, returning the renewed one.
   *
   * Fails if the presented lease is no longer current, which is how a stalled worker
   * discovers it has been superseded instead of continuing to act.
   */
  heartbeat(lease: DeployLease): Promise<Result<DeployLease>>;

  /**
   * Release the lease.
   *
   * Conditional on still holding it: a stale holder's release is a no-op rather than
   * freeing a lease that now belongs to someone else.
   */
  release(lease: DeployLease): Promise<Result<void>>;

  /**
   * Leases that expired without being released — the reconciler's entry point.
   *
   * `now` is passed in rather than read, so recovery behaviour is testable at any
   * point in time.
   */
  findExpired(now: Timestamp): Promise<Result<readonly DeployLease[]>>;
}
