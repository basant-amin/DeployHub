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
  validRawConfig,
} from "@/core/domain/deployments/deployment.fixtures";

import { FakeHealth, type TestWorld, digestOf, makeWorld, shaOf } from "./engine.fixtures";

const PREVIOUS_SHA = shaOf("a");
const NEW_SHA = shaOf("b");
const LIVE_PORT = 3001;
/** `makeProject()`'s slug, which is now also the container name (D12). */
const CONTAINER_NAME = "one-community";

/**
 * The new container answers healthily on its own port, and then the public route answers
 * with `routeStatus`. The project's spec requires three consecutive passes, so the script
 * has to satisfy the first check before the second one can fail — which is the whole point
 * of there being two checks.
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

/** Put a previous release on the host, under the project's container name. */
function seedLiveRelease(): void {
  world.containers.seedLive({
    name: CONTAINER_NAME,
    commitSha: PREVIOUS_SHA,
    digest: digestOf("c"),
    port: LIVE_PORT,
    deploymentId: world.ids.nextDeploymentId(),
  });
}

beforeEach(() => {
  world = makeWorld();
});

describe("the happy path", () => {
  it("deploys a first release under the project's container name", async () => {
    const deployment = seed();

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.state).toBe("succeeded");
    expect(finished.outcome).toBe("deployed");
    expect(finished.resolvedSha).toBe(NEW_SHA);
    expect(finished.isFirstDeploy).toBe(true);
    expect(finished.routeVerifiedAt).toBeDefined();
    expect(finished.candidate?.name).toBe(CONTAINER_NAME);
  });

  it("replaces the previous container: stop, remove, then run the same name", async () => {
    seedLiveRelease();

    const finished = expectOk(await world.engine.run(seed()));

    expect(finished.state).toBe("succeeded");
    // The classic sequence, in order and exactly once.
    expect(world.containers.stopped).toHaveLength(1);
    expect(world.containers.removed).toHaveLength(1);
    expect(world.containers.started.map((s) => s.name)).toEqual([CONTAINER_NAME]);
    // Exactly one container of this project is left standing.
    expect([...world.containers.containers.values()].map((c) => c.name)).toEqual([CONTAINER_NAME]);
  });

  it("uses the container name from the project's configuration, not the slug", async () => {
    // The whole point of the field: adopting an application already running on the host under a
    // name the platform did not choose. If this ever falls back to the slug, a first deployment
    // would leave the real container running and collide with it on the published port.
    const project = makeProject({
      config: { ...validRawConfig, containerName: "legacy-app-prod" },
    });
    world.projects.add(project);
    world.git.resolvesTo = NEW_SHA;
    world.health.outcomes = [FakeHealth.responded(200)];
    world.containers.seedLive({
      name: "legacy-app-prod",
      commitSha: PREVIOUS_SHA,
      digest: digestOf("c"),
      port: LIVE_PORT,
      deploymentId: world.ids.nextDeploymentId(),
    });
    const deployment = unwrapOrThrow(
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

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.state).toBe("succeeded");
    expect(finished.candidate?.name).toBe("legacy-app-prod");
    // It recognised the existing container as the baseline rather than treating this as a first
    // deployment, and replaced it in place.
    expect(finished.isFirstDeploy).toBe(false);
    expect(world.containers.stopped).toHaveLength(1);
    expect(world.containers.started.map((s) => s.name)).toEqual(["legacy-app-prod"]);
  });

  it("starts the new container from the digest just built", async () => {
    seedLiveRelease();

    await world.engine.run(seed());

    expect(world.containers.started[0]?.commitSha).toBe(NEW_SHA);
    expect(world.containers.started[0]?.imageDigest).toBe(digestOf(NEW_SHA.slice(0, 1)));
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

  it("does not touch the running container", async () => {
    seedLiveRelease();
    const deployment = seed();
    world.git.resolvesTo = PREVIOUS_SHA;

    await world.engine.run(deployment);

    expect(world.containers.stopped).toHaveLength(0);
    expect(world.containers.removed).toHaveLength(0);
    expect(world.containers.started).toHaveLength(0);
  });
});

describe("failures before the previous container is displaced", () => {
  beforeEach(() => {
    seedLiveRelease();
  });

  it("fails when the build fails, leaving the previous container running", async () => {
    const deployment = seed();
    world.containers.buildFailure = DeploymentError.of("BUILD_FAILED", "exit code 1");

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.state).toBe("failed");
    expect(finished.error?.code).toBe("BUILD_FAILED");
    expect(world.containers.stopped).toHaveLength(0);
    expect(world.containers.removed).toHaveLength(0);
    expect(world.lock.isHeld).toBe(false);
  });

  it("fails rather than rolls back when the previous container cannot be stopped", async () => {
    // Nothing has been displaced: the previous release is still running and still serving,
    // so there is nothing to compensate for.
    const deployment = seed();
    world.containers.stopFailure = DeploymentError.of("DOCKER_UNAVAILABLE", "daemon is gone");

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.state).toBe("failed");
    expect(finished.hasReached("rolling_back")).toBe(false);
    expect(world.containers.removed).toHaveLength(0);
  });

  it("refuses to proceed when the live container publishes no address", async () => {
    world.containers.containers.clear();
    world.containers.seedLive({
      name: CONTAINER_NAME,
      commitSha: PREVIOUS_SHA,
      digest: digestOf("c"),
      port: LIVE_PORT,
      deploymentId: world.ids.nextDeploymentId(),
    });
    for (const [id, snapshot] of world.containers.containers) {
      world.containers.containers.set(id, { ...snapshot, upstream: undefined });
    }
    const deployment = seed();

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.state).toBe("failed");
    expect(finished.error?.code).toBe("BASELINE_REQUIRED");
    expect(finished.hasReached("building")).toBe(false);
  });
});

describe("failures after the previous container is gone roll back", () => {
  beforeEach(() => {
    seedLiveRelease();
  });

  it("restarts the previous release when the new container fails its health check", async () => {
    const deployment = seed();
    world.health.outcomes = [FakeHealth.responded(503)];

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.state).toBe("rolled_back");
    expect(finished.error?.code).toBe("HEALTH_CHECK_FAILED");
    expect(finished.outcome).toBeUndefined();
    // The failed container was removed, and the previous digest was started in its place.
    const restore = world.containers.started.at(-1);
    expect(restore?.imageDigest).toBe(digestOf("c"));
    expect(restore?.commitSha).toBe(PREVIOUS_SHA);
    expect(restore?.name).toBe(CONTAINER_NAME);
    expect(world.releases.all).toHaveLength(0);
    expect(world.lock.isHeld).toBe(false);
  });

  it("restarts the previous release when the public route does not verify", async () => {
    const deployment = seed();
    world.health.outcomes = healthyThenRouteFails(502);

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.state).toBe("rolled_back");
    expect(finished.error?.code).toBe("ROUTE_VERIFICATION_FAILED");
    expect(world.containers.started.at(-1)?.commitSha).toBe(PREVIOUS_SHA);
  });

  it("rolls back when the new container exits immediately", async () => {
    const deployment = seed();
    world.containers.nextStartedState = { kind: "exited", exitCode: 1 };

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.state).toBe("rolled_back");
    expect(finished.error?.code).toBe("CONTAINER_START_FAILED");
  });

  it("rolls back when the new container cannot be started at all", async () => {
    const deployment = seed();
    world.containers.failStartNumber = 1;

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.state).toBe("rolled_back");
    // The restore is the second start, and it ran.
    expect(world.containers.started).toHaveLength(2);
    expect(world.containers.started[1]?.commitSha).toBe(PREVIOUS_SHA);
  });

  it("fails fast when the new container exits mid-probe rather than waiting out the budget", async () => {
    const deployment = seed();
    world.health.outcomes = [FakeHealth.unreachable()];
    world.containers.exitAfterInspects = 1;

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.state).toBe("rolled_back");
    expect(finished.error?.code).toBe("CONTAINER_EXITED");
  });

  it("captures the failed container's own logs before rolling back", async () => {
    const deployment = seed();
    world.health.outcomes = [FakeHealth.responded(503)];
    world.containers.logLines = ["Error: DATABASE_URL is not set"];

    await world.engine.run(deployment);

    expect(world.logs.textFor(deployment.id)).toContain("DATABASE_URL is not set");
  });

  it("ends in rollback_failed and keeps the lease when the previous release will not restart", async () => {
    const deployment = seed();
    world.health.outcomes = healthyThenRouteFails(502);
    // The deployment's own start succeeds; the restore does not.
    world.containers.failStartNumber = 2;

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.state).toBe("rollback_failed");
    expect(finished.error?.code).toBe("ROLLBACK_FAILED");
    expect(finished.retainsLock).toBe(true);
    // Invariant 7: this is the one terminal state that does not release the lease.
    expect(world.lock.isHeld).toBe(true);
    expect(world.lock.released).toHaveLength(0);
  });

  it("ends in rollback_failed when the failed container cannot be removed", async () => {
    // The name and port stay held, so the previous release has nowhere to go.
    const deployment = seed();
    world.health.outcomes = [FakeHealth.responded(503)];
    world.containers.removeFailure = DeploymentError.of("DOCKER_UNAVAILABLE", "daemon is gone");

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.state).toBe("rollback_failed");
    expect(finished.retainsLock).toBe(true);
  });
});

describe("a first deployment has nothing to roll back to", () => {
  it("completes the rollback by leaving the host as it found it", async () => {
    const deployment = seed();
    world.health.outcomes = [FakeHealth.responded(503)];

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.state).toBe("rolled_back");
    expect(finished.isFirstDeploy).toBe(true);
    // The failed container was removed and nothing was put back.
    expect(world.containers.removed).toHaveLength(1);
    expect(world.containers.containers.size).toBe(0);
    expect(world.lock.isHeld).toBe(false);
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

  it("still succeeds when the release record cannot be saved", async () => {
    const deployment = seed();
    world.releases.failOnSave = DeploymentError.of("DISK_FULL", "cannot write");

    const finished = expectOk(await world.engine.run(deployment));

    expect(finished.state).toBe("succeeded");
    expect(finished.warnings.length).toBeGreaterThan(0);
    expect(finished.warnings[0]?.step).toBe("finalize");
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
