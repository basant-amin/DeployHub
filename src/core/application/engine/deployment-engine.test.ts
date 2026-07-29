// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";

import { type Deployment, Deployment as DeploymentAggregate } from "@/core/domain";
import { DeploymentError, unwrapOrThrow } from "@/core/shared";
import { expectErr, expectOk } from "@/core/shared/result.testing";
import {
  actor,
  idempotencyKey,
  makeProject,
  targetRef,
} from "@/core/domain/deployments/deployment.fixtures";

import { FakeHealth, type TestWorld, digestOf, makeWorld, shaOf } from "./engine.fixtures";

const PREVIOUS_SHA = shaOf("a");
const NEW_SHA = shaOf("b");
const LIVE_PORT = 3001;

/**
 * The candidate answers healthily long enough to be promoted, and then the public route
 * answers with `routeStatus`. The project's spec requires three consecutive passes, so the
 * script has to satisfy the first check before the second one can fail — which is the whole
 * point of there being two checks.
 */
function healthyThenRouteFails(routeStatus: number) {
  return [
    FakeHealth.responded(200),
    FakeHealth.responded(200),
    FakeHealth.responded(200),
    FakeHealth.responded(routeStatus),
  ];
}

let world: TestWorld;

/** A project, a queued deployment, and a health probe that answers 200. */
function seed(): Deployment {
  const project = makeProject();
  world.projects.add(project);
  world.git.resolvesTo = NEW_SHA;
  world.health.outcomes = [FakeHealth.responded(200)];

  return unwrapOrThrow(
    DeploymentAggregate.request({
      id: world.ids.nextDeploymentId(),
      projectId: project.id,
      trigger: "manual",
      actor,
      targetRef,
      idempotencyKey,
      requestedAt: world.clock.now(),
    }),
  );
}

/** Put a previous release on the host, with the route pointing at it. */
function seedLiveRelease(): void {
  const live = world.containers.seedLive({
    name: "one-community-dep-00000000",
    commitSha: PREVIOUS_SHA,
    digest: digestOf("c"),
    port: LIVE_PORT,
    deploymentId: world.ids.nextDeploymentId(),
  });
  world.proxy.pointAt(live.upstream);
}

beforeEach(() => {
  world = makeWorld();
});

describe("the happy path", () => {
  it("deploys a first release and points the route at it", async () => {
    const deployment = seed();

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.state).toBe("succeeded");
    expect(finished.outcome).toBe("deployed");
    expect(finished.resolvedSha).toBe(NEW_SHA);
    expect(finished.isFirstDeploy).toBe(true);
    expect(finished.routeVerifiedAt).toBeDefined();

    // The route now serves the container this deployment started.
    const candidate = finished.candidate;
    expect(candidate).toBeDefined();
    expect(world.proxy.current?.port).toBe(candidate?.upstream.port);
  });

  it("records the transitions in the order the flow document specifies", async () => {
    const finished = expectOk(await world.engine.run(seed()));

    expect(finished.transitions.map((t) => t.to)).toEqual([
      "validating",
      "preparing",
      "fetching",
      "building",
      "starting",
      "health_checking",
      "promoting",
      "finalizing",
      "succeeded",
    ]);
  });

  it("records a release only after succeeding", async () => {
    const finished = expectOk(await world.engine.run(seed()));

    expect(world.releases.all).toHaveLength(1);
    const release = world.releases.all[0];
    expect(release?.commitSha).toBe(NEW_SHA);
    expect(release?.deploymentId).toBe(finished.id);
  });

  it("releases the lease", async () => {
    await world.engine.run(seed());
    expect(world.lock.isHeld).toBe(false);
    expect(world.lock.released).toHaveLength(1);
  });

  it("opens, writes, and completes the log", async () => {
    const deployment = seed();
    await world.engine.run(deployment);

    expect(world.logs.opened).toContain(deployment.id);
    expect(world.logs.completed).toContain(deployment.id);
    expect(world.logs.textFor(deployment.id)).toContain("preflight passed");
  });

  it("redacts secrets that appear in log output", async () => {
    const deployment = seed();
    world.containers.logLines = [`connecting with ${world.secrets.credential}`];
    world.health.outcomes = [FakeHealth.responded(500)];

    await world.engine.run(deployment);

    const log = world.logs.textFor(deployment.id);
    expect(log).not.toContain(world.secrets.credential);
    expect(log).toContain("[REDACTED]");
  });
});

describe("the no-change short circuit", () => {
  it("succeeds without building when the resolved commit is already live", async () => {
    seedLiveRelease();
    const deployment = seed();
    world.git.resolvesTo = PREVIOUS_SHA;

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.state).toBe("succeeded");
    expect(finished.outcome).toBe("no_change");
    expect(finished.hasReached("building")).toBe(false);
    expect(world.releases.all).toHaveLength(0);
    expect(world.lock.isHeld).toBe(false);
  });
});

describe("failures before promotion leave the previous release serving", () => {
  beforeEach(() => {
    seedLiveRelease();
  });

  it("fails when the build fails, without starting a container", async () => {
    const deployment = seed();
    world.containers.buildFailure = DeploymentError.of("BUILD_FAILED", "exit code 1");

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.state).toBe("failed");
    expect(finished.error?.code).toBe("BUILD_FAILED");
    expect(world.proxy.current?.port).toBe(LIVE_PORT);
    expect(world.lock.isHeld).toBe(false);
  });

  it("discards the candidate when the health check never passes", async () => {
    const deployment = seed();
    world.health.outcomes = [FakeHealth.responded(503)];

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.state).toBe("failed");
    expect(finished.error?.code).toBe("HEALTH_CHECK_FAILED");
    // The candidate was removed and traffic never moved.
    expect(world.containers.removed).toHaveLength(1);
    expect(world.proxy.current?.port).toBe(LIVE_PORT);
    expect(world.proxy.switches).toHaveLength(0);
  });

  it("captures the candidate's own logs when it fails its health check", async () => {
    const deployment = seed();
    world.health.outcomes = [FakeHealth.responded(503)];
    world.containers.logLines = ["Error: DATABASE_URL is not set"];

    await world.engine.run(deployment);

    expect(world.logs.textFor(deployment.id)).toContain("DATABASE_URL is not set");
  });

  it("fails fast when the candidate exits mid-probe rather than waiting out the budget", async () => {
    const deployment = seed();
    world.health.outcomes = [FakeHealth.unreachable()];
    world.containers.exitAfterInspects = 1;

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.state).toBe("failed");
    expect(finished.error?.code).toBe("CONTAINER_EXITED");
    expect(world.proxy.current?.port).toBe(LIVE_PORT);
  });

  it("discards a candidate that started with no reachable address", async () => {
    const deployment = seed();
    world.containers.startedState = { kind: "exited", exitCode: 1 };

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.state).toBe("failed");
    expect(finished.error?.code).toBe("CONTAINER_START_FAILED");
  });

  it("refuses to proceed when the route points at a container that does not exist", async () => {
    // The proxy claims a target, but the host has nothing answering for it, so there is no
    // rollback target and the deployment must not build.
    world.containers.containers.clear();
    const deployment = seed();

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.state).toBe("failed");
    expect(finished.error?.code).toBe("BASELINE_REQUIRED");
    expect(finished.hasReached("building")).toBe(false);
  });
});

describe("failures after promotion roll back", () => {
  beforeEach(() => {
    seedLiveRelease();
  });

  it("restores the previous release when the public route does not verify", async () => {
    const deployment = seed();
    // Healthy on the internal port, broken through the route.
    world.health.outcomes = healthyThenRouteFails(502);

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.state).toBe("rolled_back");
    expect(finished.error?.code).toBe("ROUTE_VERIFICATION_FAILED");
    expect(finished.outcome).toBeUndefined();
    // The route is back on the previous release, and the candidate is gone.
    expect(world.proxy.current?.port).toBe(LIVE_PORT);
    expect(world.containers.removed).toHaveLength(1);
    expect(world.releases.all).toHaveLength(0);
    expect(world.lock.isHeld).toBe(false);
  });

  it("ends in rollback_failed and keeps the lease when the route cannot be restored", async () => {
    const deployment = seed();
    world.health.outcomes = healthyThenRouteFails(502);
    // The promotion switch succeeds; the restore does not.
    world.proxy.failSwitchNumber = 2;

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.state).toBe("rollback_failed");
    expect(finished.error?.code).toBe("ROLLBACK_FAILED");
    expect(finished.retainsLock).toBe(true);
    // Invariant 7: this is the one terminal state that does not release the lease.
    expect(world.lock.isHeld).toBe(true);
    expect(world.lock.released).toHaveLength(0);
  });

  it("rolls back when the proxy refuses the promotion itself", async () => {
    const deployment = seed();
    world.proxy.failSwitchNumber = 1;

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.state).toBe("rolled_back");
    expect(world.proxy.current?.port).toBe(LIVE_PORT);
  });
});

describe("preflight refuses before taking the lease", () => {
  it("fails when a required secret is missing", async () => {
    const project = makeProject();
    world.projects.add(project);
    const deployment = seed();
    world.secrets.missing.add(project.config.gitCredentialRef);

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.state).toBe("failed");
    expect(finished.error?.code).toBe("PREFLIGHT_CREDENTIAL_MISSING");
    expect(finished.hasReached("preparing")).toBe(false);
    expect(world.lock.acquired).toHaveLength(0);
  });

  it("fails when the host is low on disk", async () => {
    const deployment = seed();
    world.containers.freeBytes = 100;

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.error?.code).toBe("PREFLIGHT_DISK_SPACE_LOW");
    expect(world.lock.acquired).toHaveLength(0);
  });

  it("fails when the project is disabled", async () => {
    const project = makeProject({ enabled: false });
    world.projects.add(project);
    const deployment = seed();
    world.projects.add(project);

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.error?.code).toBe("PROJECT_DISABLED");
  });

  it("fails when the project no longer exists", async () => {
    const deployment = seed();
    const world2 = makeWorld();
    world2.git.resolvesTo = NEW_SHA;

    const finished = expectOk(await world2.engine.run(deployment));

    expect(finished.error?.code).toBe("PROJECT_NOT_FOUND");
  });

  it("fails when another deployment holds the lease", async () => {
    const deployment = seed();
    world.lock.busy = true;

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.state).toBe("failed");
    expect(finished.error?.code).toBe("DEPLOYMENT_IN_PROGRESS");
  });
});

describe("finalization problems are warnings, not failures", () => {
  beforeEach(() => {
    seedLiveRelease();
  });

  it("still succeeds when the previous container cannot be stopped", async () => {
    const deployment = seed();
    world.containers.stopFailure = DeploymentError.of("DISK_FULL", "cannot stop");

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.state).toBe("succeeded");
    expect(finished.warnings).toHaveLength(1);
    expect(finished.warnings[0]?.step).toBe("finalize");
  });

  it("stops the previous container on success", async () => {
    await world.engine.run(seed());
    expect(world.containers.stopped).toHaveLength(1);
  });

  it("still succeeds when the release record cannot be saved", async () => {
    const deployment = seed();
    world.releases.failOnSave = DeploymentError.of("DISK_FULL", "cannot write");

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.state).toBe("succeeded");
    expect(finished.warnings.length).toBeGreaterThan(0);
  });
});

describe("engine bugs do not strand the lease", () => {
  it("records an internal failure and releases the lease when something throws", async () => {
    const deployment = seed();
    seedLiveRelease();
    // A port that throws instead of returning a Result is a bug in the adapter.
    world.containers.findForProject = () => {
      throw new TypeError("adapter blew up");
    };

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.state).toBe("failed");
    expect(finished.error?.code).toBe("INVARIANT_VIOLATION");
    expect(world.lock.isHeld).toBe(false);
  });

  it("propagates a persistence failure rather than pretending to deploy", async () => {
    const deployment = seed();
    world.deployments.failOnSave = DeploymentError.of("DISK_FULL", "cannot write");

    const error = expectErr(await world.engine.run(deployment));
    expect(error.code).toBe("DISK_FULL");
  });
});
