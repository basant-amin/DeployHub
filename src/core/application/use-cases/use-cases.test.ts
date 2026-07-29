// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";

import { IdempotencyKey, ReleaseId, unwrapOrThrow } from "@/core/shared";
import { expectErr, expectOk } from "@/core/shared/result.testing";
import { actor, idempotencyKey, makeProject } from "@/core/domain/deployments/deployment.fixtures";

import { FakeHealth, type TestWorld, makeWorld, shaOf } from "../engine/engine.fixtures";
import { GetDeploymentDetail } from "./get-deployment-detail";
import { GetDeploymentHistory } from "./get-deployment-history";
import { RequestDeployment } from "./request-deployment";
import { RequestRollback } from "./request-rollback";

let world: TestWorld;

function key(suffix: string): IdempotencyKey {
  return unwrapOrThrow(IdempotencyKey.parse(`click-${suffix.padStart(10, "0")}`));
}

/** Deploy once through the real engine, so history and rollback have something to work on. */
async function deployOnce(sha = shaOf("b")): Promise<void> {
  world.git.resolvesTo = sha;
  world.health.outcomes = [FakeHealth.responded(200)];
  expectOk(
    await new RequestDeployment(world).execute({
      projectId: makeProject().id,
      actor,
      idempotencyKey: key(String(world.releases.all.length + 1)),
    }),
  );
  const queued = expectOk(await world.deployments.findQueued(1))[0];
  if (queued === undefined) {
    throw new Error("expected a queued deployment to run");
  }
  expectOk(await world.engine.run(queued));
}

beforeEach(() => {
  world = makeWorld();
  world.projects.add(makeProject());
});

describe("RequestDeployment", () => {
  it("queues a deployment using the project's configured ref", async () => {
    const result = expectOk(
      await new RequestDeployment(world).execute({
        projectId: makeProject().id,
        actor,
        idempotencyKey,
      }),
    );

    expect(result.deduplicated).toBe(false);
    expect(result.deployment.state).toBe("queued");
    expect(result.deployment.targetRef).toBe("main");
    expect(result.deployment.trigger).toBe("manual");
    expect(result.deployment.actor).toBe(actor);
  });

  it("returns the original deployment when the key is replayed", async () => {
    const useCase = new RequestDeployment(world);
    const first = expectOk(
      await useCase.execute({ projectId: makeProject().id, actor, idempotencyKey }),
    );
    const second = expectOk(
      await useCase.execute({ projectId: makeProject().id, actor, idempotencyKey }),
    );

    expect(second.deduplicated).toBe(true);
    expect(second.deployment.id).toBe(first.deployment.id);
    expect(world.deployments.byId.size).toBe(1);
  });

  it("refuses while another deployment is in flight", async () => {
    const useCase = new RequestDeployment(world);
    expectOk(await useCase.execute({ projectId: makeProject().id, actor, idempotencyKey }));

    const error = expectErr(
      await useCase.execute({ projectId: makeProject().id, actor, idempotencyKey: key("2") }),
    );
    expect(error.code).toBe("DEPLOYMENT_IN_PROGRESS");
    expect(error.errorClass).toBe("PRECONDITION");
  });

  it("refuses a disabled project", async () => {
    world.projects.add(makeProject({ enabled: false }));
    const error = expectErr(
      await new RequestDeployment(world).execute({
        projectId: makeProject().id,
        actor,
        idempotencyKey,
      }),
    );
    expect(error.code).toBe("PROJECT_DISABLED");
  });

  it("refuses an unknown project", async () => {
    const empty = makeWorld();
    const error = expectErr(
      await new RequestDeployment(empty).execute({
        projectId: makeProject().id,
        actor,
        idempotencyKey,
      }),
    );
    expect(error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("honours an explicit ref override", async () => {
    const result = expectOk(
      await new RequestDeployment(world).execute({
        projectId: makeProject().id,
        actor,
        idempotencyKey,
        targetRef: makeProject().config.targetRef,
      }),
    );
    expect(result.deployment.targetRef).toBe("main");
  });
});

describe("RequestRollback", () => {
  it("queues a deployment of the target release's exact commit", async () => {
    await deployOnce(shaOf("a"));
    await deployOnce(shaOf("b"));
    const target = world.releases.all[0];
    expect(target).toBeDefined();
    if (target === undefined) return;

    const summary = expectOk(
      await new RequestRollback(world).execute({
        projectId: makeProject().id,
        releaseId: target.id,
        actor,
        idempotencyKey: key("99"),
      }),
    );

    expect(summary.trigger).toBe("rollback");
    // The sha, not a branch: a rollback must land on exactly what shipped.
    expect(summary.targetRef).toBe(target.commitSha);
    expect(summary.state).toBe("queued");
  });

  it("refuses to roll back to the release that is already live", async () => {
    await deployOnce(shaOf("a"));
    const live = expectOk(await world.releases.findLiveForProject(makeProject().id));
    expect(live).toBeDefined();
    if (live === undefined) return;

    const error = expectErr(
      await new RequestRollback(world).execute({
        projectId: makeProject().id,
        releaseId: live.id,
        actor,
        idempotencyKey: key("98"),
      }),
    );
    expect(error.code).toBe("ROLLBACK_NOT_ELIGIBLE");
    expect(error.details.reason).toBe("already_live");
  });

  it("refuses an unknown release", async () => {
    const error = expectErr(
      await new RequestRollback(world).execute({
        projectId: makeProject().id,
        releaseId: unwrapOrThrow(ReleaseId.parse("rel-00009999")),
        actor,
        idempotencyKey: key("97"),
      }),
    );
    expect(error.code).toBe("RELEASE_NOT_FOUND");
  });
});

describe("GetDeploymentHistory", () => {
  it("returns the project overview and the deployments, newest first", async () => {
    await deployOnce(shaOf("a"));
    await deployOnce(shaOf("b"));

    const history = expectOk(
      await new GetDeploymentHistory(world).execute({ projectId: makeProject().id }),
    );

    expect(history.deployments).toHaveLength(2);
    expect(history.deployments[0]?.commitSha).toBe(shaOf("b"));
    expect(history.project.slug).toBe("one-community");
    expect(history.project.liveCommitSha).toBe(shaOf("b"));
    expect(history.project.route).toBe("app.onecommunity.example");
    expect(history.project.activeDeploymentId).toBeUndefined();
  });

  it("reports the in-flight deployment so the Deploy button can disable itself", async () => {
    const requested = expectOk(
      await new RequestDeployment(world).execute({
        projectId: makeProject().id,
        actor,
        idempotencyKey,
      }),
    );

    const history = expectOk(
      await new GetDeploymentHistory(world).execute({ projectId: makeProject().id }),
    );
    expect(history.project.activeDeploymentId).toBe(requested.deployment.id);
  });

  it("returns only plain serializable data", async () => {
    await deployOnce();
    const history = expectOk(
      await new GetDeploymentHistory(world).execute({ projectId: makeProject().id }),
    );
    expect(() => JSON.stringify(history)).not.toThrow();
    expect(JSON.parse(JSON.stringify(history))).toEqual(history);
  });
});

describe("GetDeploymentDetail", () => {
  it("returns the timeline, the log, and whether to keep polling", async () => {
    await deployOnce();
    const deployment = [...world.deployments.byId.values()][0];
    expect(deployment).toBeDefined();
    if (deployment === undefined) return;

    const detail = expectOk(
      await new GetDeploymentDetail(world).execute({ deploymentId: deployment.id }),
    );

    expect(detail.state).toBe("succeeded");
    expect(detail.isActive).toBe(false);
    expect(detail.timeline.map((entry) => entry.state)).toContain("promoting");
    expect(detail.logs.length).toBeGreaterThan(0);
    expect(detail.logs[0]?.stream).toBe("system");
    expect(detail.imageDigest).toBeDefined();
    expect(() => JSON.stringify(detail)).not.toThrow();
  });

  it("refuses an unknown deployment", async () => {
    const error = expectErr(
      await new GetDeploymentDetail(world).execute({
        deploymentId: world.ids.nextDeploymentId(),
      }),
    );
    expect(error.code).toBe("DEPLOYMENT_NOT_FOUND");
  });

  it("returns the record even when the log cannot be read", async () => {
    const requested = expectOk(
      await new RequestDeployment(world).execute({
        projectId: makeProject().id,
        actor,
        idempotencyKey,
      }),
    );
    // No log was ever opened for a queued deployment.
    const queued = expectOk(await world.deployments.findQueued(1))[0];
    if (queued === undefined) {
      throw new Error("expected a queued deployment");
    }
    const detail = expectOk(
      await new GetDeploymentDetail(world).execute({ deploymentId: queued.id }),
    );
    expect(detail.id).toBe(requested.deployment.id);
    expect(detail.logs).toEqual([]);
    expect(detail.isActive).toBe(false);
  });
});
