/**
 * The store: SQLite via `node:sqlite`, no dependency and no native build.
 *
 * The schema is **snapshot plus extracted columns**, not a relational model of the aggregate.
 * A `Deployment` has twenty-odd fields plus a baseline union, a candidate, step records,
 * warnings, and a transition history; mapping that to tables would be four tables, a dozen
 * joins, and a week of tedium in exchange for queries nobody makes. Nothing ever queries
 * inside a step record.
 *
 * So each row carries the whole aggregate as JSON, and only the columns the platform actually
 * filters or sorts on are lifted out. Those columns then carry the constraints that make the
 * domain's invariants true under a race:
 *
 * - `one_active_per_project` — a partial unique index on `project_id` where the deployment is
 *   not terminal. This is invariant 1, enforced by the database rather than by a check that
 *   two concurrent requests can both pass.
 * - `unique_idempotency` — one deployment per `(project_id, idempotency_key)`, so a
 *   double-clicked Deploy button cannot produce two deployments even if both requests race.
 *
 * WAL mode is on because the web process and the worker are separate processes sharing one
 * file, and WAL is what lets a reader and a writer coexist without blocking.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { type Result, DeploymentError, err, ok } from "@/core/shared";

const SCHEMA = `
create table if not exists projects (
  id          text primary key,
  slug        text not null unique,
  snapshot    text not null,
  updated_at  integer not null
);

create table if not exists deployments (
  id                      text primary key,
  project_id              text not null,
  state                   text not null,
  is_terminal             integer not null,
  idempotency_key         text not null,
  requested_at            integer not null,
  finished_at             integer,
  cancellation_requested  integer not null default 0,
  snapshot                text not null
);

-- Invariant 1, as a constraint: at most one non-terminal deployment per project.
create unique index if not exists one_active_per_project
  on deployments(project_id) where is_terminal = 0;

-- One deployment per intent, so a replayed click cannot create a second.
create unique index if not exists unique_idempotency
  on deployments(project_id, idempotency_key);

create index if not exists deployments_by_project
  on deployments(project_id, requested_at desc);

create index if not exists deployments_queued
  on deployments(requested_at) where state = 'queued';

create table if not exists releases (
  id           text primary key,
  project_id   text not null,
  deployed_at  integer not null,
  snapshot     text not null
);

create index if not exists releases_by_project
  on releases(project_id, deployed_at desc);

create table if not exists leases (
  project_id     text primary key,
  deployment_id  text not null,
  holder         text not null,
  epoch          integer not null,
  acquired_at    integer not null,
  expires_at     integer not null
);

-- Append-only, read by polling on (deployment_id, seq).
create table if not exists log_lines (
  deployment_id  text not null,
  seq            integer not null,
  at             integer not null,
  step           text not null,
  stream         text not null,
  text           text not null,
  primary key (deployment_id, seq)
);

create table if not exists log_state (
  deployment_id  text primary key,
  completed      integer not null default 0
);
`;

/**
 * Open the store, creating it and its schema if absent.
 *
 * `create table if not exists` is the whole migration story for the MVP. A real migration
 * runner arrives with the first change that has to preserve existing rows; inventing one now
 * would be a framework with one user.
 */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const database = new DatabaseSync(path);
  database.exec("pragma journal_mode = wal");
  database.exec("pragma foreign_keys = on");
  // Wait rather than fail when the other process holds a write lock.
  database.exec("pragma busy_timeout = 5000");
  database.exec(SCHEMA);
  return database;
}

/**
 * Run a statement, turning a thrown SQLite error into a `Result`.
 *
 * Every repository method goes through this, which is what keeps `try`/`catch` out of the
 * repositories themselves and gives a unique-constraint violation one recognisable shape.
 */
export function query<T>(what: string, run: () => T): Result<T> {
  try {
    return ok(run());
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // A constraint violation is the store enforcing a domain invariant, not a broken store —
    // it means a concurrent request won the race, so report it as the precondition it is.
    if (message.includes("UNIQUE constraint failed")) {
      return err(
        DeploymentError.of(
          "DEPLOYMENT_IN_PROGRESS",
          `${what} was refused by the store: another deployment already holds this slot`,
          { details: { constraint: message } },
        ),
      );
    }
    return err(
      DeploymentError.of("STORAGE_FAILED", `${what} failed: ${message}`, {
        details: { operation: what },
      }),
    );
  }
}
