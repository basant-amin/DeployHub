/**
 * In-memory ports, for testing the application layer.
 *
 * Not fakes in the sense of "returns a canned value" — these behave. The container runtime
 * remembers what it started and stopped, the proxy remembers where a route points, and the
 * lock refuses a second holder. That is what lets a test assert the thing that actually
 * matters after a failed deployment: *the previous release is still serving traffic*.
 *
 * Every one is scriptable, because the interesting deployments are the ones that go wrong.
 */

import {
  type CommitSha,
  type ContainerId,
  type ContainerName,
  type DeploymentId,
  type GitRef,
  type IdempotencyKey,
  type ImageDigest,
  type ProjectId,
  type Redactor,
  type ReleaseId,
  type Result,
  type SecretRef,
  type Timestamp,
  CommitSha as CommitShaCodec,
  ContainerId as ContainerIdCodec,
  ContainerName as ContainerNameCodec,
  Duration,
  DeploymentError,
  DeploymentId as DeploymentIdCodec,
  ImageDigest as ImageDigestCodec,
  ImageReference,
  LockEpoch,
  ReleaseId as ReleaseIdCodec,
  Timestamp as TimestampCodec,
  err,
  ok,
  unwrapOrThrow,
} from "@/core/shared";
import {
  type Deployment,
  type Project,
  type ProxyUpstream,
  type PublicRoute,
  type Release,
  ProxyUpstream as ProxyUpstreamCodec,
} from "@/core/domain";
import type {
  AcquireLeaseRequest,
  BuiltImage,
  Clock,
  ContainerRuntime,
  ContainerSnapshot,
  ContainerStartRequest,
  ContainerState,
  DeployLease,
  DeployLock,
  DeploymentLogLine,
  DeploymentLogSink,
  DeploymentRepository,
  GitClient,
  HealthProbe,
  IdGenerator,
  ImageBuildRequest,
  ProbeOutcome,
  ProbeRequest,
  ProjectRepository,
  ReleaseRepository,
  ReverseProxy,
  SecretProvider,
  StorageHeadroom,
  WorkerId,
} from "@/core/ports";

import { DeploymentEngine } from "./deployment-engine";

const T0 = 1_760_000_000_000;
const TICK = 100;

export const WORKER: WorkerId = "worker-test" as WorkerId;

export function digestOf(fill: string): ImageDigest {
  return unwrapOrThrow(ImageDigestCodec.parse(`sha256:${fill.repeat(64).slice(0, 64)}`));
}

export function shaOf(fill: string): CommitSha {
  return unwrapOrThrow(CommitShaCodec.parse(fill.repeat(40).slice(0, 40)));
}

function upstreamAt(port: number): ProxyUpstream {
  return unwrapOrThrow(ProxyUpstreamCodec.create({ host: "127.0.0.1", port }));
}

/** Advances on every read, so timestamps are monotonic and durations are never zero. */
export class FakeClock implements Clock {
  private millis = T0;
  sleeps: number[] = [];

  now(): Timestamp {
    this.millis += TICK;
    return unwrapOrThrow(TimestampCodec.fromEpochMillis(this.millis));
  }

  async sleep(duration: Duration): Promise<void> {
    this.sleeps.push(duration.millis);
    this.millis += duration.millis;
  }
}

export class FakeIds implements IdGenerator {
  private deployments = 0;
  private releases = 0;

  nextDeploymentId(): DeploymentId {
    this.deployments += 1;
    return unwrapOrThrow(
      DeploymentIdCodec.parse(`dep-${String(this.deployments).padStart(8, "0")}`),
    );
  }

  nextReleaseId(): ReleaseId {
    this.releases += 1;
    return unwrapOrThrow(ReleaseIdCodec.parse(`rel-${String(this.releases).padStart(8, "0")}`));
  }
}

export class FakeProjects implements ProjectRepository {
  private readonly byId = new Map<string, Project>();

  add(project: Project): void {
    this.byId.set(project.id, project);
  }

  async findById(id: ProjectId): Promise<Result<Project | undefined>> {
    return ok(this.byId.get(id));
  }

  async list(): Promise<Result<readonly Project[]>> {
    return ok([...this.byId.values()]);
  }

  async save(project: Project): Promise<Result<void>> {
    this.byId.set(project.id, project);
    return ok(undefined);
  }
}

export class FakeDeployments implements DeploymentRepository {
  readonly byId = new Map<string, Deployment>();
  /** Every save, in order — the audit trail a test can assert the pipeline against. */
  readonly saves: Deployment[] = [];
  failOnSave: DeploymentError | undefined;
  private readonly cancellations = new Set<string>();

  async save(deployment: Deployment): Promise<Result<void>> {
    if (this.failOnSave !== undefined) {
      return err(this.failOnSave);
    }
    this.byId.set(deployment.id, deployment);
    this.saves.push(deployment);
    return ok(undefined);
  }

  async findById(id: DeploymentId): Promise<Result<Deployment | undefined>> {
    return ok(this.byId.get(id));
  }

  async findByIdempotencyKey(
    projectId: ProjectId,
    key: IdempotencyKey,
  ): Promise<Result<Deployment | undefined>> {
    return ok(
      [...this.byId.values()].find((d) => d.projectId === projectId && d.idempotencyKey === key),
    );
  }

  async findActiveForProject(projectId: ProjectId): Promise<Result<Deployment | undefined>> {
    return ok([...this.byId.values()].find((d) => d.projectId === projectId && !d.isTerminal));
  }

  async findQueued(limit: number): Promise<Result<readonly Deployment[]>> {
    return ok([...this.byId.values()].filter((d) => d.state === "queued").slice(0, limit));
  }

  async findUnfinished(): Promise<Result<readonly Deployment[]>> {
    return ok([...this.byId.values()].filter((d) => !d.isTerminal));
  }

  async listForProject(
    projectId: ProjectId,
    limit: number,
  ): Promise<Result<readonly Deployment[]>> {
    return ok(
      [...this.byId.values()]
        .filter((d) => d.projectId === projectId)
        .sort((a, b) => b.requestedAt.epochMillis - a.requestedAt.epochMillis)
        .slice(0, limit),
    );
  }

  async requestCancellation(id: DeploymentId): Promise<Result<void>> {
    this.cancellations.add(id);
    return ok(undefined);
  }

  async isCancellationRequested(id: DeploymentId): Promise<Result<boolean>> {
    return ok(this.cancellations.has(id));
  }

  /** The latest saved version of a deployment. */
  latest(id: DeploymentId): Deployment {
    const found = this.byId.get(id);
    if (found === undefined) {
      throw new Error(`no deployment ${id} was saved`);
    }
    return found;
  }
}

export class FakeReleases implements ReleaseRepository {
  readonly all: Release[] = [];
  failOnSave: DeploymentError | undefined;

  seed(release: Release): void {
    this.all.push(release);
  }

  async save(release: Release): Promise<Result<void>> {
    if (this.failOnSave !== undefined) {
      return err(this.failOnSave);
    }
    this.all.push(release);
    return ok(undefined);
  }

  async findById(id: ReleaseId): Promise<Result<Release | undefined>> {
    return ok(this.all.find((r) => r.id === id));
  }

  async findLiveForProject(projectId: ProjectId): Promise<Result<Release | undefined>> {
    return ok(this.newestFirst(projectId)[0]);
  }

  async listForProject(projectId: ProjectId, limit: number): Promise<Result<readonly Release[]>> {
    return ok(this.newestFirst(projectId).slice(0, limit));
  }

  private newestFirst(projectId: ProjectId): readonly Release[] {
    return this.all
      .filter((r) => r.projectId === projectId)
      .sort((a, b) => b.deployedAt.epochMillis - a.deployedAt.epochMillis);
  }
}

export class FakeLock implements DeployLock {
  private held: DeployLease | undefined;
  readonly acquired: DeployLease[] = [];
  readonly released: DeployLease[] = [];
  busy = false;

  async acquire(request: AcquireLeaseRequest): Promise<Result<DeployLease>> {
    if (this.busy || this.held !== undefined) {
      return err(
        DeploymentError.of("DEPLOYMENT_IN_PROGRESS", "another deployment holds the lease"),
      );
    }
    const lease: DeployLease = {
      projectId: request.projectId,
      deploymentId: request.deploymentId,
      holder: request.holder,
      epoch: unwrapOrThrow(LockEpoch.parse(this.acquired.length + 1)),
      acquiredAt: unwrapOrThrow(TimestampCodec.fromEpochMillis(T0)),
      expiresAt: unwrapOrThrow(TimestampCodec.fromEpochMillis(T0 + 30_000)),
    };
    this.held = lease;
    this.acquired.push(lease);
    return ok(lease);
  }

  async heartbeat(lease: DeployLease): Promise<Result<DeployLease>> {
    return ok(lease);
  }

  async release(lease: DeployLease): Promise<Result<void>> {
    this.held = undefined;
    this.released.push(lease);
    return ok(undefined);
  }

  async findExpired(): Promise<Result<readonly DeployLease[]>> {
    return ok([]);
  }

  get isHeld(): boolean {
    return this.held !== undefined;
  }
}

export class FakeGit implements GitClient {
  resolvesTo: CommitSha = shaOf("b");
  failure: DeploymentError | undefined;
  readonly checkedOut: string[] = [];

  async checkOut(_project: Project, ref: GitRef): Promise<Result<CommitSha>> {
    this.checkedOut.push(ref);
    return this.failure !== undefined ? err(this.failure) : ok(this.resolvesTo);
  }
}

/** Tracks containers as a real host would: started, stopped, removed, renamed. */
export class FakeContainers implements ContainerRuntime {
  readonly containers = new Map<string, ContainerSnapshot>();
  readonly removedImages: ImageDigest[] = [];
  readonly stopped: string[] = [];
  readonly removed: string[] = [];
  private nextPort = 4001;
  private nextId = 1;

  buildFailure: DeploymentError | undefined;
  startFailure: DeploymentError | undefined;
  removeFailure: DeploymentError | undefined;
  stopFailure: DeploymentError | undefined;
  /** State the next started container reports. */
  startedState: ContainerState = { kind: "running" };
  /** Applied to a container on the Nth inspect, to simulate a crash mid-probe. */
  exitAfterInspects: number | undefined;
  private inspects = 0;
  freeBytes = 40 * 1024 * 1024 * 1024;
  headroomFailure: DeploymentError | undefined;
  logLines: string[] = ["Error: connection refused", "exiting"];

  /** Put an already-running container on the host, as a previous release. */
  seedLive(input: {
    readonly name: string;
    readonly commitSha: CommitSha;
    readonly digest: ImageDigest;
    readonly port: number;
    readonly deploymentId: DeploymentId;
  }): ContainerSnapshot {
    const snapshot: ContainerSnapshot = {
      id: unwrapOrThrow(ContainerIdCodec.parse("a".repeat(12))),
      name: unwrapOrThrow(ContainerNameCodec.parse(input.name)),
      state: { kind: "running" },
      image: unwrapOrThrow(ImageReference.parse(`deployhub/one-community:${input.commitSha}`)),
      imageDigest: input.digest,
      commitSha: input.commitSha,
      deploymentId: input.deploymentId,
      upstream: upstreamAt(input.port),
    };
    this.containers.set(snapshot.id, snapshot);
    return snapshot;
  }

  async buildImage(request: ImageBuildRequest): Promise<Result<BuiltImage>> {
    if (this.buildFailure !== undefined) {
      return err(this.buildFailure);
    }
    return ok({
      reference: unwrapOrThrow(
        ImageReference.parse(`${request.project.config.imageRepository}:${request.commitSha}`),
      ),
      digest: digestOf(request.commitSha.slice(0, 1)),
    });
  }

  async startContainer(request: ContainerStartRequest): Promise<Result<ContainerSnapshot>> {
    if (this.startFailure !== undefined) {
      return err(this.startFailure);
    }
    this.nextId += 1;
    const snapshot: ContainerSnapshot = {
      id: unwrapOrThrow(ContainerIdCodec.parse(String(this.nextId).repeat(12).slice(0, 12))),
      name: request.name,
      state: this.startedState,
      image: request.image,
      imageDigest: request.imageDigest,
      commitSha: request.commitSha,
      deploymentId: request.deploymentId,
      upstream: this.startedState.kind === "exited" ? undefined : upstreamAt(this.nextPort++),
    };
    this.containers.set(snapshot.id, snapshot);
    return ok(snapshot);
  }

  async inspect(id: ContainerId): Promise<Result<ContainerSnapshot | undefined>> {
    this.inspects += 1;
    const snapshot = this.containers.get(id);
    if (snapshot === undefined) {
      return ok(undefined);
    }
    if (this.exitAfterInspects !== undefined && this.inspects > this.exitAfterInspects) {
      const exited: ContainerSnapshot = { ...snapshot, state: { kind: "exited", exitCode: 1 } };
      this.containers.set(id, exited);
      return ok(exited);
    }
    return ok(snapshot);
  }

  async findForProject(): Promise<Result<readonly ContainerSnapshot[]>> {
    return ok([...this.containers.values()]);
  }

  async rename(id: ContainerId, name: ContainerName): Promise<Result<void>> {
    const snapshot = this.containers.get(id);
    if (snapshot !== undefined) {
      this.containers.set(id, { ...snapshot, name });
    }
    return ok(undefined);
  }

  async stop(id: ContainerId): Promise<Result<void>> {
    if (this.stopFailure !== undefined) {
      return err(this.stopFailure);
    }
    const snapshot = this.containers.get(id);
    if (snapshot !== undefined) {
      this.containers.set(id, { ...snapshot, state: { kind: "stopped" }, upstream: undefined });
    }
    this.stopped.push(id);
    return ok(undefined);
  }

  async remove(id: ContainerId): Promise<Result<void>> {
    if (this.removeFailure !== undefined) {
      return err(this.removeFailure);
    }
    this.containers.delete(id);
    this.removed.push(id);
    return ok(undefined);
  }

  async readLogs(): Promise<Result<readonly string[]>> {
    return ok(this.logLines);
  }

  async removeImages(digests: readonly ImageDigest[]): Promise<Result<void>> {
    this.removedImages.push(...digests);
    return ok(undefined);
  }

  async readStorageHeadroom(): Promise<Result<StorageHeadroom>> {
    if (this.headroomFailure !== undefined) {
      return err(this.headroomFailure);
    }
    return ok({ freeBytes: this.freeBytes, totalBytes: 100 * 1024 * 1024 * 1024 });
  }
}

export class FakeProxy implements ReverseProxy {
  private upstream: ProxyUpstream | undefined;
  readonly switches: (ProxyUpstream | undefined)[] = [];
  switchFailure: DeploymentError | undefined;
  /** Fails only the Nth switch, so a rollback can fail while the promotion succeeded. */
  failSwitchNumber: number | undefined;

  pointAt(upstream: ProxyUpstream | undefined): void {
    this.upstream = upstream;
  }

  async readUpstream(_route: PublicRoute): Promise<Result<ProxyUpstream | undefined>> {
    return ok(this.upstream);
  }

  async pointRouteAt(_route: PublicRoute, upstream: ProxyUpstream): Promise<Result<void>> {
    const attempt = this.switches.length + 1;
    if (this.switchFailure !== undefined || this.failSwitchNumber === attempt) {
      this.switches.push(undefined);
      return err(
        this.switchFailure ??
          DeploymentError.of("PROXY_RELOAD_FAILED", "the proxy refused the change"),
      );
    }
    this.upstream = upstream;
    this.switches.push(upstream);
    return ok(undefined);
  }

  get current(): ProxyUpstream | undefined {
    return this.upstream;
  }
}

export class FakeHealth implements HealthProbe {
  /** Outcomes to return, in order. The last one repeats once exhausted. */
  outcomes: ProbeOutcome[] = [];
  readonly requests: ProbeRequest[] = [];
  failure: DeploymentError | undefined;

  static responded(status: number): ProbeOutcome {
    return {
      kind: "responded",
      status,
      latency: unwrapOrThrow(Duration.fromMillis(5)),
      bodyExcerpt: "",
    };
  }

  static unreachable(reason = "connection refused"): ProbeOutcome {
    return { kind: "unreachable", latency: unwrapOrThrow(Duration.fromMillis(5)), reason };
  }

  async probe(request: ProbeRequest): Promise<Result<ProbeOutcome>> {
    this.requests.push(request);
    if (this.failure !== undefined) {
      return err(this.failure);
    }
    const next = this.outcomes.length > 1 ? this.outcomes.shift() : this.outcomes[0];
    if (next === undefined) {
      return err(DeploymentError.of("HEALTH_CHECK_FAILED", "no scripted probe outcome"));
    }
    return ok(next);
  }
}

export class FakeLogs implements DeploymentLogSink {
  readonly lines = new Map<string, DeploymentLogLine[]>();
  readonly opened: string[] = [];
  readonly completed: string[] = [];
  redactor: Redactor | undefined;

  async open(deploymentId: DeploymentId, redactor: Redactor): Promise<Result<void>> {
    this.opened.push(deploymentId);
    this.redactor = redactor;
    this.lines.set(deploymentId, []);
    return ok(undefined);
  }

  async append(deploymentId: DeploymentId, line: DeploymentLogLine): Promise<Result<void>> {
    const existing = this.lines.get(deploymentId);
    if (existing === undefined) {
      return err(DeploymentError.of("INVARIANT_VIOLATION", "log was not opened"));
    }
    existing.push(
      this.redactor === undefined ? line : { ...line, text: this.redactor.redact(line.text) },
    );
    return ok(undefined);
  }

  async complete(deploymentId: DeploymentId): Promise<Result<void>> {
    this.completed.push(deploymentId);
    return ok(undefined);
  }

  async read(deploymentId: DeploymentId): Promise<Result<readonly DeploymentLogLine[]>> {
    return ok(this.lines.get(deploymentId) ?? []);
  }

  async *tail(deploymentId: DeploymentId): AsyncIterable<DeploymentLogLine> {
    yield* this.lines.get(deploymentId) ?? [];
  }

  textFor(deploymentId: DeploymentId): string {
    return (this.lines.get(deploymentId) ?? []).map((line) => line.text).join("\n");
  }
}

export class FakeSecrets implements SecretProvider {
  missing = new Set<string>();
  credential = "hunter2-git-token";
  environment = new Map<string, string>([["DATABASE_URL", "postgres://user:pw@db/app"]]);

  async exists(ref: SecretRef): Promise<Result<boolean>> {
    return ok(!this.missing.has(ref));
  }

  async resolveCredential(): Promise<Result<string>> {
    return ok(this.credential);
  }

  async resolveEnvironment(): Promise<Result<ReadonlyMap<string, string>>> {
    return ok(this.environment);
  }
}

/** Every port, wired to an engine. */
export interface TestWorld {
  readonly clock: FakeClock;
  readonly ids: FakeIds;
  readonly projects: FakeProjects;
  readonly deployments: FakeDeployments;
  readonly releases: FakeReleases;
  readonly lock: FakeLock;
  readonly git: FakeGit;
  readonly containers: FakeContainers;
  readonly proxy: FakeProxy;
  readonly health: FakeHealth;
  readonly logs: FakeLogs;
  readonly secrets: FakeSecrets;
  readonly engine: DeploymentEngine;
}

export function makeWorld(): TestWorld {
  const clock = new FakeClock();
  const ids = new FakeIds();
  const projects = new FakeProjects();
  const deployments = new FakeDeployments();
  const releases = new FakeReleases();
  const lock = new FakeLock();
  const git = new FakeGit();
  const containers = new FakeContainers();
  const proxy = new FakeProxy();
  const health = new FakeHealth();
  const logs = new FakeLogs();
  const secrets = new FakeSecrets();

  const engine = new DeploymentEngine(
    {
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
    },
    WORKER,
  );

  return {
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
    engine,
  };
}
