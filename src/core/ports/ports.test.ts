// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  type ContainerId,
  type ContainerName,
  type DeploymentId,
  type ImageDigest,
  type ProjectId,
  type SecretRef,
  type Timestamp,
  Duration,
  LockEpoch,
  Redactor,
  ReleaseId as ReleaseIdCodec,
  ok,
  unwrapOrThrow,
} from "@/core/shared";
import type { Deployment, Project, ProxyUpstream, PublicRoute, Release } from "@/core/domain";
import {
  at,
  candidate,
  digest,
  driveTo,
  existingBaseline,
  image,
  makeProject,
  newSha,
  queuedDeployment,
} from "@/core/domain/deployments/deployment.fixtures";

import type {
  Clock,
  ContainerRuntime,
  ContainerSnapshot,
  DeployLease,
  DeployLock,
  DeploymentEvent,
  DeploymentLogLine,
  DeploymentLogSink,
  DeploymentRepository,
  EventPublisher,
  GitClient,
  HealthProbe,
  IdGenerator,
  ProjectRepository,
  ReleaseRepository,
  ReverseProxy,
  SecretProvider,
  WorkerId,
} from ".";

/**
 * A ports layer has no behaviour to test — these are declarations. What *can* go wrong
 * is that an interface turns out to be unimplementable: it demands a domain object no
 * adapter can construct, or a shape the domain cannot produce. The stubs below are the
 * cheapest possible proof that every port can be satisfied using only domain types, and
 * they fail at compile time if a signature drifts out of reach.
 *
 * They are not fakes for the application layer to use. Phase 4C builds those against
 * the behaviour it needs.
 */

const project: Project = makeProject();
const deployment: Deployment = queuedDeployment();
const succeeded: Deployment = driveTo("succeeded");
const release: Release = unwrapOrThrow(
  succeeded.toRelease(unwrapOrThrow(ReleaseIdCodec.parse("rel-00000009"))),
);
const upstream: ProxyUpstream = candidate.upstream;
const route: PublicRoute = project.config.route;
const second = unwrapOrThrow(Duration.fromMillis(1_000));

const snapshot: ContainerSnapshot = {
  id: candidate.id,
  name: candidate.name,
  state: { kind: "running" },
  image,
  imageDigest: digest("d"),
  commitSha: newSha,
  deploymentId: deployment.id,
  upstream,
};

describe("every port is implementable with domain types", () => {
  it("Clock", async () => {
    const clock: Clock = {
      now: () => at(0),
      sleep: async () => undefined,
    };
    expect(clock.now().epochMillis).toBe(at(0).epochMillis);
    await expect(clock.sleep(second)).resolves.toBeUndefined();
  });

  it("IdGenerator", () => {
    const ids: IdGenerator = {
      nextDeploymentId: () => deployment.id,
      nextReleaseId: () => release.id,
    };
    expect(ids.nextDeploymentId()).toBe(deployment.id);
    expect(ids.nextReleaseId()).toBe(release.id);
  });

  it("ProjectRepository", async () => {
    const projects: ProjectRepository = {
      findById: async (id: ProjectId) => ok(id === project.id ? project : undefined),
      list: async () => ok([project]),
      save: async () => ok(undefined),
    };
    const found = await projects.findById(project.id);
    expect(found.ok && found.value?.slug).toBe("one-community");
  });

  it("DeploymentRepository", async () => {
    const deployments: DeploymentRepository = {
      save: async () => ok(undefined),
      findById: async (id: DeploymentId) => ok(id === deployment.id ? deployment : undefined),
      findByIdempotencyKey: async () => ok(deployment),
      findActiveForProject: async () => ok(undefined),
      findQueued: async () => ok([deployment]),
      findUnfinished: async () => ok([]),
      listForProject: async () => ok([succeeded]),
      requestCancellation: async () => ok(undefined),
      isCancellationRequested: async () => ok(false),
    };
    const queued = await deployments.findQueued(10);
    expect(queued.ok && queued.value[0]?.state).toBe("queued");
  });

  it("ReleaseRepository", async () => {
    const releases: ReleaseRepository = {
      save: async () => ok(undefined),
      findById: async () => ok(release),
      findLiveForProject: async () => ok(release),
      listForProject: async () => ok([release]),
    };
    const live = await releases.findLiveForProject(project.id);
    expect(live.ok && live.value?.commitSha).toBe(newSha);
  });

  it("DeployLock", async () => {
    const holder = "worker-1" as WorkerId;
    const lease: DeployLease = {
      projectId: project.id,
      deploymentId: deployment.id,
      holder,
      epoch: unwrapOrThrow(LockEpoch.parse(1)),
      acquiredAt: at(0),
      expiresAt: at(30),
    };
    const lock: DeployLock = {
      acquire: async () => ok(lease),
      heartbeat: async (current: DeployLease) => ok({ ...current, expiresAt: at(60) }),
      release: async () => ok(undefined),
      findExpired: async (now: Timestamp) => ok(now.isBefore(lease.expiresAt) ? [] : [lease]),
    };
    const expired = await lock.findExpired(at(120));
    expect(expired.ok && expired.value).toHaveLength(1);
  });

  it("GitClient", async () => {
    const git: GitClient = {
      checkOut: async () => ok(newSha),
    };
    const resolved = await git.checkOut(project, project.config.targetRef);
    expect(resolved.ok && resolved.value).toBe(newSha);
  });

  it("ContainerRuntime", async () => {
    const runtime: ContainerRuntime = {
      buildImage: async () => ok({ reference: image, digest: digest("d") }),
      startContainer: async () => ok(snapshot),
      inspect: async (id: ContainerId) => ok(id === snapshot.id ? snapshot : undefined),
      findForProject: async () => ok([snapshot]),
      rename: async (_id: ContainerId, _name: ContainerName) => ok(undefined),
      stop: async (_id: ContainerId, _grace: Duration) => ok(undefined),
      remove: async () => ok(undefined),
      readLogs: async () => ok(["listening on 3000"]),
      removeImages: async (_digests: readonly ImageDigest[]) => ok(undefined),
      readStorageHeadroom: async () =>
        ok({ freeBytes: 40_000_000_000, totalBytes: 100_000_000_000 }),
    };

    const built = await runtime.buildImage({
      project,
      commitSha: newSha,
      deploymentId: deployment.id,
      actor: deployment.actor,
    });
    expect(built.ok && built.value.reference.toString()).toBe(image.toString());

    const started = await runtime.startContainer({
      project,
      name: candidate.name,
      image,
      imageDigest: digest("d"),
      commitSha: newSha,
      deploymentId: deployment.id,
      environment: new Map([["NODE_ENV", "production"]]),
    });
    expect(started.ok && started.value.state.kind).toBe("running");
  });

  it("ReverseProxy", async () => {
    const proxy: ReverseProxy = {
      readUpstream: async () => ok(existingBaseline.upstream),
      pointRouteAt: async () => ok(undefined),
    };
    const current = await proxy.readUpstream(route);
    expect(current.ok && current.value?.port).toBe(3001);
    expect((await proxy.pointRouteAt(route, upstream)).ok).toBe(true);
  });

  it("HealthProbe", async () => {
    const probe: HealthProbe = {
      probe: async (request) =>
        ok(
          request.target.kind === "upstream"
            ? { kind: "responded", status: 200, latency: second, bodyExcerpt: "ok" }
            : { kind: "unreachable", latency: second, reason: "connection refused" },
        ),
    };

    const direct = await probe.probe({
      target: { kind: "upstream", upstream },
      path: project.config.healthCheck.path,
      timeout: second,
    });
    expect(direct.ok && direct.value.kind === "responded" && direct.value.status).toBe(200);

    const viaRoute = await probe.probe({
      target: { kind: "route", route },
      path: project.config.healthCheck.path,
      timeout: second,
    });
    expect(viaRoute.ok && viaRoute.value.kind).toBe("unreachable");
  });

  it("DeploymentLogSink", async () => {
    const lines: DeploymentLogLine[] = [];
    const sink: DeploymentLogSink = {
      open: async () => ok(undefined),
      append: async (_id, line) => {
        lines.push(line);
        return ok(undefined);
      },
      complete: async () => ok(undefined),
      read: async () => ok(lines),
      tail: async function* () {
        yield* lines;
      },
    };

    expect((await sink.open(deployment.id, Redactor.create(["hunter2pass"]))).ok).toBe(true);
    await sink.append(deployment.id, {
      at: at(1),
      step: "build",
      stream: "stdout",
      text: "Step 1/9",
    });
    const streamed: DeploymentLogLine[] = [];
    for await (const line of sink.tail(deployment.id)) {
      streamed.push(line);
    }
    expect(streamed).toHaveLength(1);
    expect(streamed[0]?.step).toBe("build");
  });

  it("EventPublisher", async () => {
    const published: DeploymentEvent[] = [];
    const events: EventPublisher = {
      publish: async (event) => {
        published.push(event);
        return ok(undefined);
      },
    };
    await events.publish({
      kind: "deployment.state_changed",
      deploymentId: deployment.id,
      projectId: project.id,
      at: at(1),
      from: "queued",
      to: "validating",
      reason: undefined,
    });
    await events.publish({
      kind: "deployment.step_finished",
      deploymentId: deployment.id,
      projectId: project.id,
      at: at(2),
      step: "build",
      status: "succeeded",
      duration: second,
    });
    expect(published.map((e) => e.kind)).toEqual([
      "deployment.state_changed",
      "deployment.step_finished",
    ]);
  });

  it("SecretProvider", async () => {
    const secrets: SecretProvider = {
      exists: async () => ok(true),
      resolveCredential: async () => ok("hunter2pass"),
      resolveEnvironment: async () => ok(new Map([["DATABASE_URL", "postgres://localhost/x"]])),
    };
    const ref: SecretRef = project.config.gitCredentialRef;
    expect((await secrets.exists(ref)).ok).toBe(true);
    const env = await secrets.resolveEnvironment(project.config.runtimeEnvRef);
    expect(env.ok && env.value.get("DATABASE_URL")).toContain("postgres://");
  });
});
