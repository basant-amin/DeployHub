// @vitest-environment node
import { describe, expect, it } from "vitest";

import { expectOk } from "@/core/shared/result.testing";

import {
  ensureNoActiveDeployment,
  findActiveDeployment,
  findByIdempotencyKey,
} from "./concurrency";
import { DEPLOYMENT_STATES } from "./deployment-state";
import {
  at,
  driveTo,
  idempotencyKey,
  makeProject,
  newSha,
  previousSha,
  queuedDeployment,
  releaseFrom,
  releaseId,
  sha,
} from "./deployment.fixtures";
import { assessRollback } from "./rollback";

const liveRelease = releaseFrom("rel-00000002", newSha);
const olderRelease = releaseFrom("rel-00000003", previousSha);

describe("rollback eligibility", () => {
  const project = makeProject();

  it("allows rolling back to an older release", () => {
    const eligibility = assessRollback({
      project,
      target: olderRelease,
      liveRelease,
      hasActiveDeployment: false,
    });
    expect(eligibility.eligible).toBe(true);
    if (!eligibility.eligible) return;
    expect(eligibility.target.id).toBe(olderRelease.id);
    expect(eligibility.target.commitSha).not.toBe(liveRelease.commitSha);
  });

  it("allows a rollback when no live release is recorded", () => {
    expect(
      assessRollback({
        project,
        target: olderRelease,
        liveRelease: undefined,
        hasActiveDeployment: false,
      }).eligible,
    ).toBe(true);
  });

  it("refuses when the project is disabled", () => {
    const eligibility = assessRollback({
      project: project.disable(),
      target: olderRelease,
      liveRelease,
      hasActiveDeployment: false,
    });
    expect(eligibility.eligible).toBe(false);
    if (eligibility.eligible) return;
    expect(eligibility.reason).toBe("project_disabled");
    expect(eligibility.explanation).toContain("one-community");
  });

  it("refuses a release from another project", () => {
    const eligibility = assessRollback({
      project: makeProject({ id: "prj-other-product", slug: "other-product" }),
      target: olderRelease,
      liveRelease: undefined,
      hasActiveDeployment: false,
    });
    expect(eligibility.eligible).toBe(false);
    if (eligibility.eligible) return;
    expect(eligibility.reason).toBe("release_project_mismatch");
  });

  it("refuses while a deployment is already running", () => {
    const eligibility = assessRollback({
      project,
      target: olderRelease,
      liveRelease,
      hasActiveDeployment: true,
    });
    expect(eligibility.eligible).toBe(false);
    if (eligibility.eligible) return;
    expect(eligibility.reason).toBe("deployment_in_progress");
  });

  it("refuses rolling back to what is already live", () => {
    const eligibility = assessRollback({
      project,
      target: liveRelease,
      liveRelease,
      hasActiveDeployment: false,
    });
    expect(eligibility.eligible).toBe(false);
    if (eligibility.eligible) return;
    expect(eligibility.reason).toBe("already_live");
  });

  it("refuses a different release that ships the live commit", () => {
    const duplicateOfLive = releaseFrom("rel-00000004", newSha);
    const eligibility = assessRollback({
      project,
      target: duplicateOfLive,
      liveRelease,
      hasActiveDeployment: false,
    });
    expect(eligibility.eligible).toBe(false);
    if (eligibility.eligible) return;
    expect(eligibility.reason).toBe("same_commit_as_live");
  });

  it("reports the most fundamental reason when several apply", () => {
    const eligibility = assessRollback({
      project: project.disable(),
      target: liveRelease,
      liveRelease,
      hasActiveDeployment: true,
    });
    expect(eligibility.eligible).toBe(false);
    if (eligibility.eligible) return;
    expect(eligibility.reason).toBe("project_disabled");
  });
});

describe("invariant 1 — single writer per project", () => {
  it("finds nothing among terminal deployments", () => {
    const terminal = [driveTo("succeeded"), driveTo("failed"), driveTo("rolled_back")];
    expect(findActiveDeployment(terminal)).toBeUndefined();
    expect(ensureNoActiveDeployment(terminal).ok).toBe(true);
    expect(ensureNoActiveDeployment([]).ok).toBe(true);
  });

  it("treats a queued deployment as occupying the slot", () => {
    expect(findActiveDeployment([driveTo("succeeded"), queuedDeployment()])?.state).toBe("queued");
  });

  it("rejects admission for every non-terminal state", () => {
    const terminal = new Set(["succeeded", "failed", "rolled_back", "canceled", "rollback_failed"]);
    for (const state of DEPLOYMENT_STATES.filter((s) => !terminal.has(s))) {
      const existing =
        state === "interrupted"
          ? expectOk(driveTo("building").markInterrupted(at(40)))
          : driveTo(state);
      const gate = ensureNoActiveDeployment([existing]);
      expect(gate.ok, state).toBe(false);
      if (gate.ok) continue;
      expect(gate.error.code).toBe("DEPLOYMENT_IN_PROGRESS");
      expect(gate.error.errorClass).toBe("PRECONDITION");
      expect(gate.error.details.activeState).toBe(state);
    }
  });

  it("finds a replayed request by its idempotency key", () => {
    const existing = queuedDeployment();
    expect(findByIdempotencyKey([existing], idempotencyKey)?.id).toBe(existing.id);
    expect(findByIdempotencyKey([], idempotencyKey)).toBeUndefined();
  });
});

describe("Release", () => {
  it("carries the digest, not only the tag, so the target is unambiguous", () => {
    expect(liveRelease.imageDigest.startsWith("sha256:")).toBe(true);
    expect(liveRelease.image.tag).not.toBe(liveRelease.imageDigest);
  });

  it("compares by identity and by commit", () => {
    const sameCommit = releaseFrom("rel-00000005", newSha);
    expect(liveRelease.equals(liveRelease)).toBe(true);
    expect(liveRelease.equals(sameCommit)).toBe(false);
    expect(liveRelease.hasSameCommit(sameCommit)).toBe(true);
    expect(liveRelease.hasSameCommit(olderRelease)).toBe(false);
  });

  it("ships the commit it was built from", () => {
    expect(releaseFrom("rel-00000006", sha("e")).commitSha).toBe(sha("e"));
  });

  it("is dated at the moment the deployment finished, not when it was recorded", () => {
    const deployment = driveTo("succeeded");
    const finishedAt = deployment.finishedAt;
    const release = expectOk(deployment.toRelease(releaseId));
    if (finishedAt === undefined) {
      throw new Error("a succeeded deployment must record a finish time");
    }
    expect(release.deployedAt.equals(finishedAt)).toBe(true);
    expect(release.duration.millis).toBe(deployment.totalDuration?.millis);
  });

  it("serializes to plain JSON", () => {
    const json = liveRelease.toJSON();
    expect(json.id).toBe("rel-00000002");
    expect(typeof json.deployedAt).toBe("number");
    expect(() => JSON.stringify(json)).not.toThrow();
  });
});
