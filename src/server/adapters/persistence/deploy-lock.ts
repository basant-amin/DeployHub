/**
 * `DeployLock` — a lease in one SQLite row per project.
 *
 * The whole point is that acquisition is a **single atomic statement**. A read followed by a
 * write would let two workers both see a free lock and both take it, and no amount of care in
 * the surrounding code fixes that. So the insert and the takeover-if-expired are one
 * `insert … on conflict … do update … where expires_at <= ?`, and SQLite decides the winner.
 *
 * A lease is not a mutex: it expires. A worker that dies takes nothing with it, and the boot
 * sweep can recover the deployment it abandoned. Every takeover increments the epoch, which is
 * the fencing token — a worker that stalled past its lease and resumes still carries the old
 * one, so its release is a no-op rather than freeing a lease that now belongs to someone else.
 */

import type { DatabaseSync } from "node:sqlite";

import {
  type Result,
  type Timestamp,
  DeploymentError,
  LockEpoch,
  Timestamp as TimestampCodec,
  err,
  ok,
} from "@/core/shared";
import type { AcquireLeaseRequest, DeployLease, DeployLock, WorkerId } from "@/core/ports";

import { query } from "./database";

interface LeaseRow {
  readonly project_id: string;
  readonly deployment_id: string;
  readonly holder: string;
  readonly epoch: number;
  readonly acquired_at: number;
  readonly expires_at: number;
}

export interface LeaseOptions {
  /** How long a lease is valid without a heartbeat. */
  readonly ttlMillis: number;
}

export class SqliteDeployLock implements DeployLock {
  constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => Timestamp,
    private readonly options: LeaseOptions,
  ) {}

  async acquire(request: AcquireLeaseRequest): Promise<Result<DeployLease>> {
    const acquiredAt = this.now().epochMillis;
    const expiresAt = acquiredAt + this.options.ttlMillis;

    // One statement. Insert when free; take over and bump the epoch when expired; do nothing
    // when someone else holds a live lease.
    const written = query("acquire lease", () =>
      this.database
        .prepare(
          `insert into leases (project_id, deployment_id, holder, epoch, acquired_at, expires_at)
           values (?, ?, ?, 1, ?, ?)
           on conflict(project_id) do update set
             deployment_id = excluded.deployment_id,
             holder        = excluded.holder,
             epoch         = leases.epoch + 1,
             acquired_at   = excluded.acquired_at,
             expires_at    = excluded.expires_at
           where leases.expires_at <= ?`,
        )
        .run(
          request.projectId,
          request.deploymentId,
          request.holder,
          acquiredAt,
          expiresAt,
          acquiredAt,
        ),
    );
    if (!written.ok) {
      return written;
    }
    if (Number(written.value.changes) === 0) {
      return err(
        DeploymentError.of(
          "LOCK_BUSY",
          `Another deployment holds the lease for project ${request.projectId}`,
          { details: { projectId: request.projectId } },
        ),
      );
    }

    return this.read(request.projectId);
  }

  /**
   * Extend the lease, but only if this holder still owns it at this epoch.
   *
   * A failure here is how a stalled worker discovers it has been superseded, which is the
   * moment it must stop touching the server.
   */
  async heartbeat(lease: DeployLease): Promise<Result<DeployLease>> {
    const expiresAt = this.now().epochMillis + this.options.ttlMillis;
    const written = query("renew lease", () =>
      this.database
        .prepare(
          `update leases set expires_at = ?
           where project_id = ? and holder = ? and epoch = ?`,
        )
        .run(expiresAt, lease.projectId, lease.holder, lease.epoch),
    );
    if (!written.ok) {
      return written;
    }
    if (Number(written.value.changes) === 0) {
      return err(
        DeploymentError.of(
          "LOCK_BUSY",
          `The lease for project ${lease.projectId} is no longer held at epoch ${lease.epoch}`,
          { details: { projectId: lease.projectId, epoch: lease.epoch } },
        ),
      );
    }
    return this.read(lease.projectId);
  }

  /** Conditional on the epoch, so a stale holder cannot free someone else's lease. */
  async release(lease: DeployLease): Promise<Result<void>> {
    const written = query("release lease", () =>
      this.database
        .prepare("delete from leases where project_id = ? and holder = ? and epoch = ?")
        .run(lease.projectId, lease.holder, lease.epoch),
    );
    return written.ok ? ok(undefined) : written;
  }

  async findExpired(now: Timestamp): Promise<Result<readonly DeployLease[]>> {
    const rows = query("find expired leases", () =>
      this.database.prepare("select * from leases where expires_at <= ?").all(now.epochMillis),
    );
    if (!rows.ok) {
      return rows;
    }
    const leases: DeployLease[] = [];
    for (const row of rows.value as unknown as readonly LeaseRow[]) {
      const lease = toLease(row);
      if (lease.ok) {
        leases.push(lease.value);
      }
    }
    return ok(leases);
  }

  private read(projectId: string): Result<DeployLease> {
    const row = query("read lease", () =>
      this.database.prepare("select * from leases where project_id = ?").get(projectId),
    );
    if (!row.ok) {
      return row;
    }
    if (row.value === undefined) {
      return err(
        DeploymentError.of("STORAGE_FAILED", "the lease vanished immediately after being taken"),
      );
    }
    return toLease(row.value as unknown as LeaseRow);
  }
}

function toLease(row: LeaseRow): Result<DeployLease> {
  const epoch = LockEpoch.parse(row.epoch);
  const acquiredAt = TimestampCodec.fromEpochMillis(row.acquired_at);
  const expiresAt = TimestampCodec.fromEpochMillis(row.expires_at);
  if (!epoch.ok) return epoch;
  if (!acquiredAt.ok) return acquiredAt;
  if (!expiresAt.ok) return expiresAt;

  // The ids were validated when the deployment that owns them was created; a lease row is
  // written only by this adapter, from values that already parsed.
  return ok({
    projectId: row.project_id as DeployLease["projectId"],
    deploymentId: row.deployment_id as DeployLease["deploymentId"],
    holder: row.holder as WorkerId,
    epoch: epoch.value,
    acquiredAt: acquiredAt.value,
    expiresAt: expiresAt.value,
  });
}
