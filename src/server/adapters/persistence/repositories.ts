/**
 * The three repositories, over SQLite.
 *
 * Each is a thin translation between a domain object and one row: encode to a snapshot, lift
 * out the columns the platform filters on, write. Reading goes back through the codec, which
 * finishes at `Deployment.rehydrate` — so a row that has drifted out of a legal shape is
 * rejected at the boundary rather than resumed.
 *
 * `undefined` inside a successful `Result` means "no such row"; a failed `Result` means the
 * store could not answer. Those are different things and the engine treats them differently.
 */

import type { DatabaseSync } from "node:sqlite";

import {
  type DeploymentId,
  type IdempotencyKey,
  type ProjectId,
  type ReleaseId,
  type Result,
  ok,
} from "@/core/shared";
import type { Deployment, Project, Release } from "@/core/domain";
import type { DeploymentRepository, ProjectRepository, ReleaseRepository } from "@/core/ports";

import { query } from "./database";
import {
  decodeDeployment,
  decodeProject,
  decodeRelease,
  encodeDeployment,
  encodeProject,
  encodeRelease,
} from "./codecs";

interface SnapshotRow {
  readonly snapshot: string;
}

export class SqliteProjectRepository implements ProjectRepository {
  constructor(private readonly database: DatabaseSync) {}

  async findById(id: ProjectId): Promise<Result<Project | undefined>> {
    const row = query("read project", () =>
      this.database.prepare("select snapshot from projects where id = ?").get(id),
    );
    if (!row.ok) {
      return row;
    }
    return row.value === undefined
      ? ok(undefined)
      : decodeProject((row.value as unknown as SnapshotRow).snapshot);
  }

  async list(): Promise<Result<readonly Project[]>> {
    const rows = query("list projects", () =>
      this.database.prepare("select snapshot from projects order by slug").all(),
    );
    if (!rows.ok) {
      return rows;
    }
    const projects: Project[] = [];
    for (const row of rows.value as unknown as readonly SnapshotRow[]) {
      const project = decodeProject(row.snapshot);
      if (!project.ok) {
        return project;
      }
      projects.push(project.value);
    }
    return ok(projects);
  }

  async save(project: Project): Promise<Result<void>> {
    const written = query("save project", () =>
      this.database
        .prepare(
          `insert into projects (id, slug, snapshot, updated_at) values (?, ?, ?, ?)
           on conflict(id) do update set slug = excluded.slug, snapshot = excluded.snapshot,
                                         updated_at = excluded.updated_at`,
        )
        .run(project.id, project.slug, encodeProject(project), Date.now()),
    );
    return written.ok ? ok(undefined) : written;
  }
}

export class SqliteDeploymentRepository implements DeploymentRepository {
  constructor(private readonly database: DatabaseSync) {}

  /**
   * Insert or replace, lifting out the columns that carry the constraints.
   *
   * `is_terminal` exists solely to feed the partial unique index that enforces invariant 1 —
   * the database, not a check, is what makes "one active deployment per project" true when two
   * requests arrive together.
   */
  async save(deployment: Deployment): Promise<Result<void>> {
    const written = query("save deployment", () =>
      this.database
        .prepare(
          `insert into deployments
             (id, project_id, state, is_terminal, idempotency_key, requested_at, finished_at, snapshot)
           values (?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(id) do update set state = excluded.state,
                                         is_terminal = excluded.is_terminal,
                                         finished_at = excluded.finished_at,
                                         snapshot = excluded.snapshot`,
        )
        .run(
          deployment.id,
          deployment.projectId,
          deployment.state,
          deployment.isTerminal ? 1 : 0,
          deployment.idempotencyKey,
          deployment.requestedAt.epochMillis,
          deployment.finishedAt?.epochMillis ?? null,
          encodeDeployment(deployment),
        ),
    );
    return written.ok ? ok(undefined) : written;
  }

  async findById(id: DeploymentId): Promise<Result<Deployment | undefined>> {
    return this.one("read deployment", "select snapshot from deployments where id = ?", [id]);
  }

  async findByIdempotencyKey(
    projectId: ProjectId,
    key: IdempotencyKey,
  ): Promise<Result<Deployment | undefined>> {
    return this.one(
      "read deployment by key",
      "select snapshot from deployments where project_id = ? and idempotency_key = ?",
      [projectId, key],
    );
  }

  async findActiveForProject(projectId: ProjectId): Promise<Result<Deployment | undefined>> {
    return this.one(
      "read active deployment",
      "select snapshot from deployments where project_id = ? and is_terminal = 0",
      [projectId],
    );
  }

  async findQueued(limit: number): Promise<Result<readonly Deployment[]>> {
    return this.many(
      "read queued deployments",
      "select snapshot from deployments where state = 'queued' order by requested_at limit ?",
      [limit],
    );
  }

  async findUnfinished(): Promise<Result<readonly Deployment[]>> {
    return this.many(
      "read unfinished deployments",
      "select snapshot from deployments where is_terminal = 0 order by requested_at",
      [],
    );
  }

  async listForProject(
    projectId: ProjectId,
    limit: number,
  ): Promise<Result<readonly Deployment[]>> {
    return this.many(
      "list deployments",
      "select snapshot from deployments where project_id = ? order by requested_at desc limit ?",
      [projectId, limit],
    );
  }

  async requestCancellation(id: DeploymentId): Promise<Result<void>> {
    const written = query("request cancellation", () =>
      this.database
        .prepare("update deployments set cancellation_requested = 1 where id = ?")
        .run(id),
    );
    return written.ok ? ok(undefined) : written;
  }

  async isCancellationRequested(id: DeploymentId): Promise<Result<boolean>> {
    const row = query("read cancellation flag", () =>
      this.database
        .prepare("select cancellation_requested as flag from deployments where id = ?")
        .get(id),
    );
    if (!row.ok) {
      return row;
    }
    const flag = (row.value as unknown as { readonly flag?: number } | undefined)?.flag;
    return ok(flag === 1);
  }

  private async one(
    what: string,
    sql: string,
    parameters: readonly (string | number)[],
  ): Promise<Result<Deployment | undefined>> {
    const row = query(what, () => this.database.prepare(sql).get(...parameters));
    if (!row.ok) {
      return row;
    }
    return row.value === undefined
      ? ok(undefined)
      : decodeDeployment((row.value as unknown as SnapshotRow).snapshot);
  }

  private async many(
    what: string,
    sql: string,
    parameters: readonly (string | number)[],
  ): Promise<Result<readonly Deployment[]>> {
    const rows = query(what, () => this.database.prepare(sql).all(...parameters));
    if (!rows.ok) {
      return rows;
    }
    const deployments: Deployment[] = [];
    for (const row of rows.value as unknown as readonly SnapshotRow[]) {
      const deployment = decodeDeployment(row.snapshot);
      if (!deployment.ok) {
        return deployment;
      }
      deployments.push(deployment.value);
    }
    return ok(deployments);
  }
}

export class SqliteReleaseRepository implements ReleaseRepository {
  constructor(private readonly database: DatabaseSync) {}

  async save(release: Release): Promise<Result<void>> {
    const written = query("save release", () =>
      this.database
        .prepare(
          `insert into releases (id, project_id, deployed_at, snapshot) values (?, ?, ?, ?)
           on conflict(id) do update set snapshot = excluded.snapshot`,
        )
        .run(release.id, release.projectId, release.deployedAt.epochMillis, encodeRelease(release)),
    );
    return written.ok ? ok(undefined) : written;
  }

  async findById(id: ReleaseId): Promise<Result<Release | undefined>> {
    const row = query("read release", () =>
      this.database.prepare("select snapshot from releases where id = ?").get(id),
    );
    if (!row.ok) {
      return row;
    }
    return row.value === undefined
      ? ok(undefined)
      : decodeRelease((row.value as unknown as SnapshotRow).snapshot);
  }

  /**
   * The newest release for a project.
   *
   * Derived rather than flagged: "live" is a consequence of being the most recent thing that
   * shipped, and a `is_live` column would be a second source of truth to keep in step.
   */
  async findLiveForProject(projectId: ProjectId): Promise<Result<Release | undefined>> {
    const listed = await this.listForProject(projectId, 1);
    return listed.ok ? ok(listed.value[0]) : listed;
  }

  async listForProject(projectId: ProjectId, limit: number): Promise<Result<readonly Release[]>> {
    const rows = query("list releases", () =>
      this.database
        .prepare(
          "select snapshot from releases where project_id = ? order by deployed_at desc limit ?",
        )
        .all(projectId, limit),
    );
    if (!rows.ok) {
      return rows;
    }
    const releases: Release[] = [];
    for (const row of rows.value as unknown as readonly SnapshotRow[]) {
      const release = decodeRelease(row.snapshot);
      if (!release.ok) {
        return release;
      }
      releases.push(release.value);
    }
    return ok(releases);
  }
}
