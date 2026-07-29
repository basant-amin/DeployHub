/**
 * The composition root — the one place concrete adapters are chosen.
 *
 * Nothing else in the codebase names an adapter. The engine and the use cases take ports, so
 * swapping SQLite for Postgres or Caddy for Traefik is an edit to this file and nothing else.
 * That property is the return on the whole ports layer, and it only holds if this stays the
 * single point of wiring.
 */

import { hostname } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  DeploymentEngine,
  GetDeploymentDetail,
  GetDeploymentHistory,
  RequestDeployment,
  RequestRollback,
} from "@/core/application";
import type { WorkerId } from "@/core/ports";

import { LocalCommandRunner } from "../adapters/command-runner";
import { CaddyReverseProxy } from "../adapters/caddy/reverse-proxy";
import { DockerContainerRuntime } from "../adapters/docker/container-runtime";
import { CommandGitClient } from "../adapters/git/git-client";
import { FetchHealthProbe } from "../adapters/health/health-probe";
import { SystemClock, UuidIdGenerator } from "../adapters/local/clock";
import { SqliteLogSink } from "../adapters/logs/log-sink";
import { openDatabase } from "../adapters/persistence/database";
import { SqliteDeployLock } from "../adapters/persistence/deploy-lock";
import {
  SqliteDeploymentRepository,
  SqliteProjectRepository,
  SqliteReleaseRepository,
} from "../adapters/persistence/repositories";
import { FileSecretProvider } from "../adapters/secrets/file-secret-provider";

/**
 * Everything the platform needs to know about the machine it is running on.
 *
 * Read from the environment by `runtimeConfigFromEnv`, with defaults that work on a Linux
 * server. There is no config file: a handful of environment variables is less to get wrong.
 */
export interface RuntimeConfig {
  /** SQLite file. Holds projects, deployments, releases, leases, and logs. */
  readonly databasePath: string;
  /** Directory holding one git workspace per project. */
  readonly workspaceRoot: string;
  /** JSON file of secrets, mode 0600. */
  readonly secretsPath: string;
  /** Caddy's admin endpoint. */
  readonly caddyAdminUrl: string;
  /** The server key inside Caddy's `apps.http.servers`. */
  readonly caddyServerName: string;
  /** Address containers are published on, and therefore probed at. */
  readonly bindHost: string;
  /** Scheme and port Caddy serves the public route on. */
  readonly publicScheme: "http" | "https";
  readonly publicPort: number;
  /** Filesystem whose free space preflight checks. */
  readonly storagePath: string;
  /** How long a deploy lease survives without a heartbeat. */
  readonly leaseTtlMillis: number;
}

export function runtimeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const root = env.DEPLOYHUB_ROOT ?? "/var/lib/deployhub";
  return {
    databasePath: env.DEPLOYHUB_DATABASE ?? join(root, "deployhub.db"),
    workspaceRoot: env.DEPLOYHUB_WORKSPACES ?? join(root, "projects"),
    secretsPath: env.DEPLOYHUB_SECRETS ?? join(root, "secrets.json"),
    caddyAdminUrl: env.DEPLOYHUB_CADDY_ADMIN ?? "http://localhost:2019",
    caddyServerName: env.DEPLOYHUB_CADDY_SERVER ?? "main",
    bindHost: env.DEPLOYHUB_BIND_HOST ?? "127.0.0.1",
    publicScheme: env.DEPLOYHUB_PUBLIC_SCHEME === "http" ? "http" : "https",
    publicPort: Number(env.DEPLOYHUB_PUBLIC_PORT ?? 443),
    storagePath: env.DEPLOYHUB_STORAGE_PATH ?? "/var/lib/docker",
    leaseTtlMillis: Number(env.DEPLOYHUB_LEASE_TTL_MS ?? 60_000),
  };
}

/** The wired platform. Built once per process. */
export interface Platform {
  readonly config: RuntimeConfig;
  readonly database: DatabaseSync;
  readonly workerId: WorkerId;
  readonly clock: SystemClock;
  readonly containers: DockerContainerRuntime;
  readonly proxy: CaddyReverseProxy;
  readonly engine: DeploymentEngine;
  readonly requestDeployment: RequestDeployment;
  readonly requestRollback: RequestRollback;
  readonly getDeploymentHistory: GetDeploymentHistory;
  readonly getDeploymentDetail: GetDeploymentDetail;
  readonly projects: SqliteProjectRepository;
  readonly deployments: SqliteDeploymentRepository;
  readonly releases: SqliteReleaseRepository;
  readonly lock: SqliteDeployLock;
  readonly logs: SqliteLogSink;
  readonly close: () => void;
}

export function createPlatform(config: RuntimeConfig): Platform {
  const database = openDatabase(config.databasePath);
  const clock = new SystemClock();
  const ids = new UuidIdGenerator();
  const runner = new LocalCommandRunner();

  const projects = new SqliteProjectRepository(database);
  const deployments = new SqliteDeploymentRepository(database);
  const releases = new SqliteReleaseRepository(database);
  const lock = new SqliteDeployLock(database, () => clock.now(), {
    ttlMillis: config.leaseTtlMillis,
  });
  const logs = new SqliteLogSink(database);
  const secrets = new FileSecretProvider(config.secretsPath);

  const git = new CommandGitClient(runner, secrets, { root: config.workspaceRoot });
  const containers = new DockerContainerRuntime(runner, {
    root: config.workspaceRoot,
    bindHost: config.bindHost,
    storagePath: config.storagePath,
  });
  const proxy = new CaddyReverseProxy({
    adminUrl: config.caddyAdminUrl,
    serverName: config.caddyServerName,
    timeoutMillis: 10_000,
  });
  const health = new FetchHealthProbe({
    publicScheme: config.publicScheme,
    publicPort: config.publicPort,
  });

  // Identifies this process in a lease, so a takeover can say who was superseded.
  const workerId = `${hostname()}-${process.pid}` as WorkerId;

  const ports = {
    clock,
    ids,
    projects,
    deployments,
    releases,
    lock,
    git,
    containers,
    proxy,
    health,
    logs,
    secrets,
  };

  return {
    config,
    database,
    workerId,
    clock,
    containers,
    proxy,
    engine: new DeploymentEngine(ports, workerId),
    requestDeployment: new RequestDeployment(ports),
    requestRollback: new RequestRollback(ports),
    getDeploymentHistory: new GetDeploymentHistory(ports),
    getDeploymentDetail: new GetDeploymentDetail(ports),
    projects,
    deployments,
    releases,
    lock,
    logs,
    close: () => {
      database.close();
    },
  };
}
