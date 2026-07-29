// @vitest-environment node
import { describe, expect, it } from "vitest";

import { Timestamp } from "@/core/shared";
import { expectErr, expectOk } from "@/core/shared/result.testing";

import { Deployment, type DeploymentSnapshot } from "./deployment";
import { DEPLOYMENT_STATES } from "./deployment-state";
import { at, driveTo, healthCheckFailure, previousSha } from "./deployment.fixtures";

/** The issues a rejected snapshot reports, joined for substring assertions. */
function issuesFor(snapshot: DeploymentSnapshot): string {
  const error = expectErr(Deployment.rehydrate(snapshot));
  expect(error.code).toBe("DEPLOYMENT_INVALID");
  return error.issues.join(" | ");
}

describe("round-tripping a valid record", () => {
  it("restores every state the pipeline can produce", () => {
    for (const state of DEPLOYMENT_STATES.filter((s) => s !== "interrupted")) {
      const original = driveTo(state);
      const restored = expectOk(Deployment.rehydrate(original.toSnapshot()));
      expect(restored.state, state).toBe(original.state);
      expect(restored.transitions).toHaveLength(original.transitions.length);
      expect(restored.toJSON()).toEqual(original.toJSON());
    }
  });

  it("restores an interrupted record with its origin", () => {
    const interrupted = expectOk(driveTo("promoting").markInterrupted(at(40)));
    const restored = expectOk(Deployment.rehydrate(interrupted.toSnapshot()));
    expect(restored.interruptedFrom).toBe("promoting");
  });
});

describe("the transition history must be coherent", () => {
  it("rejects a state that disagrees with the last transition", () => {
    const snapshot: DeploymentSnapshot = {
      ...driveTo("building").toSnapshot(),
      state: "succeeded",
    };
    expect(issuesFor(snapshot)).toContain("last transition ended in");
  });

  it("rejects a non-queued state with no transitions at all", () => {
    const snapshot: DeploymentSnapshot = {
      ...driveTo("validating").toSnapshot(),
      transitions: [],
    };
    expect(issuesFor(snapshot)).toContain("no transitions are recorded");
  });

  it("rejects a fabricated illegal transition", () => {
    const original = driveTo("building").toSnapshot();
    const forged: DeploymentSnapshot = {
      ...original,
      state: "promoting",
      transitions: [
        ...original.transitions,
        { from: "building", to: "promoting", at: at(30), reason: undefined },
      ],
    };
    expect(issuesFor(forged)).toContain("is illegal");
  });

  it("rejects a chain with a gap between one transition and the next", () => {
    const original = driveTo("preparing").toSnapshot();
    const forged: DeploymentSnapshot = {
      ...original,
      transitions: [
        ...original.transitions,
        { from: "fetching", to: "building", at: at(30), reason: undefined },
      ],
      state: "building",
    };
    expect(issuesFor(forged)).toContain("but the previous state was");
  });

  it("rejects a history that revisits a state", () => {
    const original = driveTo("validating").toSnapshot();
    const forged: DeploymentSnapshot = {
      ...original,
      transitions: [
        ...original.transitions,
        { from: "validating", to: "validating", at: at(3), reason: undefined },
      ],
    };
    expect(issuesFor(forged)).toContain("entered more than once");
  });

  it("rejects a history where time runs backwards", () => {
    const original = driveTo("preparing").toSnapshot();
    const [first, second] = original.transitions;
    if (first === undefined || second === undefined) {
      throw new Error("fixture should have two transitions");
    }
    const forged: DeploymentSnapshot = {
      ...original,
      transitions: [first, { ...second, at: expectOk(Timestamp.fromEpochMillis(1)) }],
    };
    expect(issuesFor(forged)).toContain("precedes");
  });
});

describe("a state's required fields must be present", () => {
  it("rejects a lock-holding state with no fencing epoch", () => {
    expect(issuesFor({ ...driveTo("building").toSnapshot(), lockEpoch: undefined })).toContain(
      "requires a held lock",
    );
  });

  it("rejects a pre-lock state that already carries an epoch", () => {
    const snapshot = driveTo("preparing").toSnapshot();
    const [first] = snapshot.transitions;
    if (first === undefined) throw new Error("fixture should have a transition");
    expect(issuesFor({ ...snapshot, state: "validating", transitions: [first] })).toContain(
      "precedes lock acquisition",
    );
  });

  it("rejects a build with no baseline or resolved sha", () => {
    const issues = issuesFor({
      ...driveTo("building").toSnapshot(),
      baseline: undefined,
      resolvedSha: undefined,
    });
    expect(issues).toContain("without a captured baseline");
    expect(issues).toContain("without a resolved commit sha");
  });

  it("rejects a candidate start with no image, and a health check with no candidate", () => {
    expect(
      issuesFor({
        ...driveTo("starting").toSnapshot(),
        image: undefined,
        imageDigest: undefined,
      }),
    ).toContain("without a built image");
    expect(
      issuesFor({ ...driveTo("health_checking").toSnapshot(), candidate: undefined }),
    ).toContain("without a candidate container");
  });

  it("rejects a promotion with no recorded health check", () => {
    expect(
      issuesFor({ ...driveTo("promoting").toSnapshot(), healthCheckPassedAt: undefined }),
    ).toContain("without a passed health check");
  });

  it("rejects a finalization with no route verification", () => {
    expect(
      issuesFor({ ...driveTo("finalizing").toSnapshot(), routeVerifiedAt: undefined }),
    ).toContain("reached finalizing without route verification");
  });

  /**
   * The rule that closes the reconciler's back door. `succeeded` is reachable from
   * `interrupted` without ever entering `finalizing`, so the check on `finalizing`
   * alone would let an unverified success be stored and reloaded.
   */
  it("rejects a deployed success with no route verification, however it was reached", () => {
    const viaFinalizing: DeploymentSnapshot = {
      ...driveTo("succeeded").toSnapshot(),
      routeVerifiedAt: undefined,
    };
    expect(issuesFor(viaFinalizing)).toContain("without verification through the public route");

    const interrupted = expectOk(driveTo("promoting").markInterrupted(at(40))).toSnapshot();
    const viaReconciliation: DeploymentSnapshot = {
      ...interrupted,
      state: "succeeded",
      outcome: "deployed",
      finishedAt: at(41),
      transitions: [
        ...interrupted.transitions,
        { from: "interrupted", to: "succeeded", at: at(41), reason: "reconciled" },
      ],
    };
    expect(issuesFor(viaReconciliation)).toContain("without verification through the public route");
  });

  it("accepts a no-change success with no route verification, since nothing shipped", () => {
    const resolved = expectOk(driveTo("fetching").recordResolvedSource(at(9), previousSha));
    const done = expectOk(resolved.completeWithoutChange(at(10)));
    expect(done.outcome).toBe("no_change");
    expect(done.routeVerifiedAt).toBeUndefined();
    expect(Deployment.rehydrate(done.toSnapshot()).ok).toBe(true);
  });
});

describe("outcome, error, and finish time", () => {
  it("rejects a failure with no error", () => {
    const failed = expectOk(driveTo("building").fail(at(60), healthCheckFailure())).toSnapshot();
    expect(issuesFor({ ...failed, error: undefined })).toContain("requires a recorded error");
  });

  it("rejects a success with no outcome, and a non-success that has one", () => {
    expect(issuesFor({ ...driveTo("succeeded").toSnapshot(), outcome: undefined })).toContain(
      "must record an outcome",
    );
    expect(issuesFor({ ...driveTo("building").toSnapshot(), outcome: "deployed" })).toContain(
      "must not record an outcome",
    );
  });

  it("rejects a deployed success with no container", () => {
    expect(issuesFor({ ...driveTo("succeeded").toSnapshot(), candidate: undefined })).toContain(
      "must record the container it shipped",
    );
  });

  it("rejects a terminal state with no finish time, and a live one that has one", () => {
    expect(issuesFor({ ...driveTo("succeeded").toSnapshot(), finishedAt: undefined })).toContain(
      "must record when it finished",
    );
    expect(issuesFor({ ...driveTo("building").toSnapshot(), finishedAt: at(99) })).toContain(
      "must not record a finish time",
    );
  });

  it("rejects an interrupted record with an impossible origin", () => {
    const interrupted = expectOk(driveTo("building").markInterrupted(at(40))).toSnapshot();
    expect(issuesFor({ ...interrupted, interruptedFrom: "succeeded" })).toContain(
      "not an interruptible state",
    );
    expect(issuesFor({ ...interrupted, interruptedFrom: undefined })).toContain(
      "must record the state it was interrupted from",
    );
  });
});
