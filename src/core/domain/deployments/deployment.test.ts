// @vitest-environment node
import { describe, expect, it } from "vitest";

import { DeploymentError } from "@/core/shared";
import { expectErr, expectOk } from "@/core/shared/result.testing";

import { Baselines } from "./baseline";
import { Deployment } from "./deployment";
import {
  at,
  candidate,
  digestFor,
  driveTo,
  existingBaseline,
  healthCheckFailure,
  image,
  lockEpoch,
  newSha,
  previousSha,
  queuedDeployment,
  releaseId,
  rollbackTrigger,
} from "./deployment.fixtures";
import { DeploymentWarning } from "./warning";

describe("requesting a deployment", () => {
  it("starts queued, with nothing else assumed", () => {
    const deployment = queuedDeployment();
    expect(deployment.state).toBe("queued");
    expect(deployment.isActive).toBe(false);
    expect(deployment.isTerminal).toBe(false);
    expect(deployment.requiresLock).toBe(false);
    expect(deployment.lockEpoch).toBeUndefined();
    expect(deployment.baseline).toBeUndefined();
    expect(deployment.resolvedSha).toBeUndefined();
    expect(deployment.routeVerifiedAt).toBeUndefined();
    expect(deployment.finishedAt).toBeUndefined();
    expect(deployment.transitions).toHaveLength(0);
  });

  it("rejects an unknown trigger even when the type says otherwise", () => {
    const result = Deployment.request({
      ...queuedDeployment().toSnapshot(),
      trigger: "webhook" as never,
    });
    expect(expectErr(result).code).toBe("DEPLOYMENT_INVALID");
  });

  it("records a rollback as a trigger, not a separate mechanism", () => {
    expect(queuedDeployment({ trigger: "rollback" }).trigger).toBe("rollback");
  });
});

describe("the happy path", () => {
  it("walks queued to succeeded and records the trail", () => {
    const deployed = driveTo("succeeded");
    expect(deployed.state).toBe("succeeded");
    expect(deployed.outcome).toBe("deployed");
    expect(deployed.routeVerifiedAt).toBeDefined();
    expect(deployed.finishedAt).toBeDefined();
    expect(deployed.totalDuration?.millis).toBeGreaterThan(0);

    expect(deployed.transitions.map((t) => t.to)).toEqual([
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

  it("is immutable — every transition returns a new instance", () => {
    const queued = queuedDeployment();
    const validating = expectOk(queued.startValidation(at(1)));
    expect(validating).not.toBe(queued);
    expect(queued.state).toBe("queued");
    expect(Object.isFrozen(queued.toSnapshot())).toBe(true);
  });

  it("produces a release from a verified success", () => {
    const release = expectOk(driveTo("succeeded").toRelease(releaseId));
    expect(release.commitSha).toBe(newSha);
    expect(release.imageDigest).toBe(digestFor(newSha));
    expect(release.containerId).toBe(candidate.id);
    expect(release.image.toString()).toBe(image.toString());
    expect(release.duration.millis).toBeGreaterThan(0);
  });

  it("refuses to produce a release from anything else", () => {
    for (const state of ["building", "rolled_back", "failed", "canceled"] as const) {
      expect(expectErr(driveTo(state).toRelease(releaseId)).code, state).toBe(
        "OPERATION_NOT_VALID_IN_STATE",
      );
    }
  });
});

describe("invariants 1 and 2 — lock discipline", () => {
  it("records the fencing epoch when the lock is acquired", () => {
    const preparing = driveTo("preparing");
    expect(preparing.lockEpoch).toBe(lockEpoch);
    expect(preparing.requiresLock).toBe(true);
  });

  it("holds no lock while validating, and needs none", () => {
    expect(driveTo("validating").lockEpoch).toBeUndefined();
    expect(driveTo("validating").requiresLock).toBe(false);
  });

  it("retains the lock only in rollback_failed", () => {
    expect(driveTo("rollback_failed").retainsLock).toBe(true);
    expect(driveTo("rolled_back").retainsLock).toBe(false);
    expect(driveTo("succeeded").retainsLock).toBe(false);
  });
});

describe("invariant 3 — no build without a rollback target", () => {
  it("cannot build before the ref is resolved", () => {
    expect(expectErr(driveTo("fetching").beginBuild(at(9))).code).toBe("SOURCE_NOT_RESOLVED");
  });

  it("records a first deployment explicitly rather than discovering it later", () => {
    const fetching = driveTo("fetching", { baseline: Baselines.firstDeploy() });
    expect(fetching.isFirstDeploy).toBe(true);
    const resolved = expectOk(fetching.recordResolvedSource(at(9), newSha));
    expect(expectOk(resolved.beginBuild(at(10))).state).toBe("building");
  });

  it("reaches building only through a captured baseline", () => {
    // `fetching` is the sole entry to `building`, and `captureBaseline` is the sole
    // entry to `fetching`, so the invariant holds structurally.
    expect(driveTo("building").baseline).toBeDefined();
    expect(driveTo("building").resolvedSha).toBe(newSha);
  });
});

describe("invariant 4 — health check before promotion, route before success", () => {
  it("refuses promotion when the health check has not been recorded", () => {
    const checking = driveTo("health_checking");
    expect(checking.healthCheckPassedAt).toBeUndefined();
    expect(expectErr(checking.beginPromotion(at(20))).code).toBe("HEALTH_CHECK_NOT_PASSED");
  });

  it("allows promotion once it has", () => {
    const passed = expectOk(driveTo("health_checking").recordHealthCheckPassed(at(20)));
    expect(passed.healthCheckPassedAt).toBeDefined();
    expect(expectOk(passed.beginPromotion(at(21))).state).toBe("promoting");
  });

  it("refuses finalization until the public route has answered", () => {
    const promoting = driveTo("promoting");
    expect(promoting.routeVerifiedAt).toBeUndefined();
    expect(expectErr(promoting.beginFinalization(at(30))).code).toBe("ROUTE_NOT_VERIFIED");
  });

  it("records route verification only while promoting", () => {
    expect(expectErr(driveTo("health_checking").recordRouteVerified(at(30))).code).toBe(
      "OPERATION_NOT_VALID_IN_STATE",
    );
  });
});

describe("invariant 5 — no going back", () => {
  it("refuses every transition out of a terminal state", () => {
    for (const state of [
      "succeeded",
      "failed",
      "rolled_back",
      "canceled",
      "rollback_failed",
    ] as const) {
      const terminal = driveTo(state);
      expect(expectErr(terminal.startValidation(at(90))).code, state).toBe(
        "ILLEGAL_STATE_TRANSITION",
      );
      expect(expectErr(terminal.cancel(at(90))).code, state).toBe("ILLEGAL_STATE_TRANSITION");
      expect(expectErr(terminal.markInterrupted(at(90))).code, state).toBe(
        "OPERATION_NOT_VALID_IN_STATE",
      );
    }
  });

  it("refuses to skip a step in the pipeline", () => {
    expect(expectErr(driveTo("building").beginPromotion(at(40))).code).toBe(
      "ILLEGAL_STATE_TRANSITION",
    );
    expect(expectErr(driveTo("validating").captureBaseline(at(40), existingBaseline)).code).toBe(
      "ILLEGAL_STATE_TRANSITION",
    );
    // The transition guard runs before the precondition, so a wrong-state call names
    // the illegal move rather than an unmet precondition that is merely a symptom.
    expect(expectErr(driveTo("preparing").beginBuild(at(40))).code).toBe(
      "ILLEGAL_STATE_TRANSITION",
    );
    expect(expectErr(driveTo("building").beginHealthCheck(at(40))).code).toBe(
      "ILLEGAL_STATE_TRANSITION",
    );
  });

  it("keeps time moving forward", () => {
    expect(expectErr(driveTo("validating").beginPreparation(at(-5), lockEpoch)).code).toBe(
      "NON_MONOTONIC_TIMESTAMP",
    );
    expect(expectErr(driveTo("fetching").recordResolvedSource(at(-5), newSha)).code).toBe(
      "NON_MONOTONIC_TIMESTAMP",
    );
  });
});

describe("invariant 6 — cancellation is bounded", () => {
  it("can be cancelled at a step boundary before promotion", () => {
    for (const state of [
      "queued",
      "preparing",
      "fetching",
      "building",
      "starting",
      "health_checking",
    ] as const) {
      const canceled = expectOk(driveTo(state).cancel(at(60), "operator changed their mind"));
      expect(canceled.state, state).toBe("canceled");
      expect(canceled.finishedAt).toBeDefined();
      expect(canceled.outcome).toBeUndefined();
    }
  });

  it("cannot be cancelled during or after promotion", () => {
    for (const state of ["promoting", "finalizing", "rolling_back"] as const) {
      expect(expectErr(driveTo(state).cancel(at(60))).code, state).toBe("ILLEGAL_STATE_TRANSITION");
    }
  });
});

describe("invariant 8 — every failure carries a code", () => {
  it("records the error and its code as the transition reason", () => {
    const failed = expectOk(driveTo("health_checking").fail(at(70), healthCheckFailure()));
    expect(failed.state).toBe("failed");
    expect(failed.error?.code).toBe("HEALTH_CHECK_FAILED");
    expect(failed.transitions.at(-1)?.reason).toBe("HEALTH_CHECK_FAILED");
    expect(failed.hasReached("promoting")).toBe(false);
  });

  it("fails from each pre-promotion state", () => {
    for (const state of [
      "validating",
      "preparing",
      "fetching",
      "building",
      "starting",
      "health_checking",
    ] as const) {
      expect(expectOk(driveTo(state).fail(at(70), healthCheckFailure())).state, state).toBe(
        "failed",
      );
    }
  });
});

describe("the no-change short circuit", () => {
  it("succeeds without shipping when the resolved sha is already live", () => {
    const resolved = expectOk(driveTo("fetching").recordResolvedSource(at(9), previousSha));
    const done = expectOk(resolved.completeWithoutChange(at(10)));
    expect(done.state).toBe("succeeded");
    expect(done.outcome).toBe("no_change");
    expect(done.hasReached("promoting")).toBe(false);
  });

  it("produces no release, because nothing shipped", () => {
    const resolved = expectOk(driveTo("fetching").recordResolvedSource(at(9), previousSha));
    const done = expectOk(resolved.completeWithoutChange(at(10)));
    expect(expectErr(done.toRelease(releaseId)).message).toContain("shipped nothing");
  });

  it("refuses to claim no change when the sha differs", () => {
    const resolved = expectOk(driveTo("fetching").recordResolvedSource(at(9), newSha));
    expect(expectErr(resolved.completeWithoutChange(at(10))).code).toBe("INVARIANT_VIOLATION");
  });

  it("refuses to claim no change on a first deployment", () => {
    const resolved = expectOk(
      driveTo("fetching", { baseline: Baselines.firstDeploy() }).recordResolvedSource(
        at(9),
        newSha,
      ),
    );
    expect(expectErr(resolved.completeWithoutChange(at(10))).code).toBe("BASELINE_REQUIRED");
  });

  it("refuses to claim no change before resolving the ref", () => {
    expect(expectErr(driveTo("fetching").completeWithoutChange(at(10))).code).toBe(
      "SOURCE_NOT_RESOLVED",
    );
  });
});

describe("rollback after a failed promotion", () => {
  it("rolls back and keeps the reason", () => {
    const rolledBack = driveTo("rolled_back");
    expect(rolledBack.state).toBe("rolled_back");
    expect(rolledBack.error?.code).toBe("ROUTE_VERIFICATION_FAILED");
    expect(rolledBack.outcome).toBeUndefined();
    expect(rolledBack.finishedAt).toBeDefined();
  });

  it("ends in rollback_failed when recovery itself fails", () => {
    const stuck = driveTo("rollback_failed");
    expect(stuck.state).toBe("rollback_failed");
    expect(stuck.retainsLock).toBe(true);
    expect(stuck.error).toBeDefined();
  });

  // The classic strategy displaces the previous container before starting the new one, so
  // from `starting` onward there is an outage to compensate for rather than a candidate to
  // discard. These two states are the boundary that moved when the strategy did (D12).
  it("is reachable from starting, once the previous container has been displaced", () => {
    const rollingBack = expectOk(driveTo("starting").beginRollback(at(80), rollbackTrigger()));
    expect(rollingBack.state).toBe("rolling_back");
    expect(rollingBack.error).toBeDefined();
  });

  it("is reachable from health_checking, where the container probed is already serving", () => {
    const rollingBack = expectOk(
      driveTo("health_checking").beginRollback(at(80), rollbackTrigger()),
    );
    expect(rollingBack.state).toBe("rolling_back");
  });

  it("is unreachable before a container has been started", () => {
    expect(expectErr(driveTo("building").beginRollback(at(80), rollbackTrigger())).code).toBe(
      "ILLEGAL_STATE_TRANSITION",
    );
  });
});

describe("interruption and reconciliation", () => {
  it("records the state the worker died in", () => {
    const interrupted = expectOk(driveTo("building").markInterrupted(at(40)));
    expect(interrupted.state).toBe("interrupted");
    expect(interrupted.interruptedFrom).toBe("building");
    expect(interrupted.isActive).toBe(true);
    expect(interrupted.isTerminal).toBe(false);
    expect(interrupted.finishedAt).toBeUndefined();
  });

  it("can be interrupted from every active state", () => {
    for (const state of [
      "validating",
      "preparing",
      "fetching",
      "building",
      "starting",
      "health_checking",
      "promoting",
      "finalizing",
      "rolling_back",
    ] as const) {
      expect(expectOk(driveTo(state).markInterrupted(at(45))).interruptedFrom, state).toBe(state);
    }
  });

  it("cannot be interrupted from a pending or terminal state", () => {
    expect(expectErr(queuedDeployment().markInterrupted(at(1))).code).toBe(
      "OPERATION_NOT_VALID_IN_STATE",
    );
    expect(expectErr(driveTo("succeeded").markInterrupted(at(50))).code).toBe(
      "OPERATION_NOT_VALID_IN_STATE",
    );
  });

  it("resolves to failed when the candidate never took traffic", () => {
    const interrupted = expectOk(driveTo("building").markInterrupted(at(40)));
    const failed = expectOk(
      interrupted.resolveInterruptedAsFailed(
        at(41),
        DeploymentError.of("INVARIANT_VIOLATION", "worker died mid-build"),
      ),
    );
    expect(failed.state).toBe("failed");
    expect(failed.transitions.at(-1)?.reason).toBe("reconciled");
  });

  it("resolves to rollback_failed when the server state is ambiguous", () => {
    const interrupted = expectOk(driveTo("promoting").markInterrupted(at(45)));
    const stuck = expectOk(
      interrupted.resolveInterruptedAsRollbackFailed(
        at(46),
        DeploymentError.of("ROLLBACK_FAILED", "cannot determine the live container"),
      ),
    );
    expect(stuck.state).toBe("rollback_failed");
    expect(stuck.retainsLock).toBe(true);
  });

  it("refuses reconciliation of a deployment that was not interrupted", () => {
    expect(expectErr(driveTo("building").resolveInterruptedAsSucceeded(at(50))).code).toBe(
      "OPERATION_NOT_VALID_IN_STATE",
    );
  });
});

/**
 * The reconciler reaches `succeeded` from `interrupted` without passing through
 * `finalizing`, so it is the one path that could report a success the normal pipeline
 * would have refused. These tests exist because it previously could.
 */
describe("reconciliation cannot manufacture an unverified success", () => {
  it("refuses to resolve as succeeded when the route was never verified", () => {
    for (const state of [
      "validating",
      "building",
      "starting",
      "health_checking",
      "promoting",
    ] as const) {
      const interrupted = expectOk(driveTo(state).markInterrupted(at(45)));
      const error = expectErr(interrupted.resolveInterruptedAsSucceeded(at(46)));
      expect(error.code, state).toBe("ROUTE_NOT_VERIFIED");
      expect(interrupted.state, state).toBe("interrupted");
    }
  });

  it("resolves to succeeded once verification is on the record", () => {
    // Interrupted during finalization: promotion completed and the route answered, so
    // re-running finalization is legitimate.
    const interrupted = expectOk(driveTo("finalizing").markInterrupted(at(45)));
    expect(interrupted.routeVerifiedAt).toBeDefined();
    const succeeded = expectOk(interrupted.resolveInterruptedAsSucceeded(at(46)));
    expect(succeeded.state).toBe("succeeded");
    expect(succeeded.outcome).toBe("deployed");
    expect(expectOk(succeeded.toRelease(releaseId)).commitSha).toBe(newSha);
  });

  it("closes every path to a release, so no unreachable third check is needed", () => {
    // A Deployment can only be obtained two ways, and both refuse an unverified
    // deployed success: the transition (above) and rehydration.
    const interrupted = expectOk(driveTo("promoting").markInterrupted(at(45)));
    expect(interrupted.resolveInterruptedAsSucceeded(at(46)).ok).toBe(false);

    const forged = Deployment.rehydrate({
      ...driveTo("succeeded").toSnapshot(),
      routeVerifiedAt: undefined,
    });
    expect(forged.ok).toBe(false);
    if (forged.ok) return;
    expect(forged.error.issues.join(" ")).toContain(
      "without verification through the public route",
    );
  });
});

describe("warnings", () => {
  it("attach without changing the outcome", () => {
    const warned = expectOk(
      driveTo("finalizing").addWarning(
        DeploymentWarning.create("DISK_FULL", "prune skipped", at(50), "finalize"),
      ),
    );
    const succeeded = expectOk(warned.succeed(at(51)));
    expect(succeeded.state).toBe("succeeded");
    expect(succeeded.outcome).toBe("deployed");
    expect(succeeded.warnings).toHaveLength(1);
    expect(succeeded.warnings[0]?.step).toBe("finalize");
  });

  it("can be recorded after the deployment has ended, as compensations do", () => {
    const failed = expectOk(driveTo("building").fail(at(50), healthCheckFailure()));
    const warned = expectOk(
      failed.addWarning(
        DeploymentWarning.fromError(
          DeploymentError.of("DISK_FULL", "could not remove candidate").withStep("build"),
          at(51),
        ),
      ),
    );
    expect(warned.warnings).toHaveLength(1);
    expect(warned.warnings[0]?.step).toBe("build");
    expect(warned.state).toBe("failed");
  });

  it("drops an unrecognized step rather than smuggling it in as a StepName", () => {
    const warning = DeploymentWarning.fromError(
      DeploymentError.of("DISK_FULL", "x").withStep("not-a-step"),
      at(51),
    );
    expect(warning.step).toBeUndefined();
  });

  it("cannot predate the request", () => {
    expect(
      expectErr(queuedDeployment().addWarning(DeploymentWarning.create("DISK_FULL", "x", at(-10))))
        .code,
    ).toBe("NON_MONOTONIC_TIMESTAMP");
  });
});

describe("step records", () => {
  it("tracks one running step at a time", () => {
    const started = expectOk(driveTo("building").startStep("build", at(20)));
    expect(started.currentStep).toBe("build");
    expect(expectErr(started.startStep("promote", at(21))).message).toContain("still running");
  });

  it("closes a step with a duration", () => {
    const started = expectOk(driveTo("building").startStep("build", at(20)));
    const finished = expectOk(started.completeStep(at(50)));
    expect(finished.currentStep).toBeUndefined();
    const record = finished.steps[0];
    expect(record?.status).toBe("succeeded");
    if (record?.status === "succeeded") {
      expect(record.duration.millis).toBe(30_000);
      expect(record.attempts).toBe(1);
    }
  });

  it("accumulates attempts on a retry rather than adding records", () => {
    const started = expectOk(driveTo("building").startStep("build", at(20)));
    const retried = expectOk(expectOk(started.retryStep()).retryStep());
    expect(retried.steps).toHaveLength(1);
    const record = retried.steps[0];
    expect(record?.status === "running" && record.attempts).toBe(3);
  });

  it("stamps a failing step with its own name", () => {
    const started = expectOk(driveTo("building").startStep("build", at(20)));
    const failed = expectOk(
      started.failStep(at(25), DeploymentError.of("BUILD_FAILED", "exit code 1")),
    );
    const record = failed.steps[0];
    expect(record?.status).toBe("failed");
    if (record?.status === "failed") {
      expect(record.error.step).toBe("build");
    }
  });

  it("refuses to finish a step that never started, or to record one twice", () => {
    const building = driveTo("building");
    expect(expectErr(building.completeStep(at(20))).message).toContain("requires a running step");
    const done = expectOk(expectOk(building.startStep("build", at(20))).completeStep(at(21)));
    expect(expectErr(done.startStep("build", at(22))).message).toContain("already been recorded");
    expect(expectErr(done.skipStep("build", at(22), "again")).message).toContain(
      "already been recorded",
    );
  });

  it("records a deliberately skipped step", () => {
    const skipped = expectOk(
      driveTo("building").skipStep("build", at(20), "image already present"),
    );
    expect(skipped.steps[0]?.status).toBe("skipped");
    expect(skipped.currentStep).toBeUndefined();
  });

  it("refuses a step that finishes before it started", () => {
    const started = expectOk(driveTo("building").startStep("build", at(20)));
    expect(expectErr(started.completeStep(at(10))).code).toBe("STEP_RECORD_INVALID");
  });
});

describe("serialization", () => {
  it("renders a deployment as plain JSON without leaking objects", () => {
    const json = driveTo("succeeded").toJSON();
    expect(json.state).toBe("succeeded");
    expect(json.resolvedSha).toBe(newSha);
    expect(json.image).toBe(image.toString());
    expect(typeof json.requestedAt).toBe("number");
    expect(typeof json.routeVerifiedAt).toBe("number");
    expect(() => JSON.stringify(json)).not.toThrow();
  });

  it("renders a baseline as JSON in both of its shapes", () => {
    expect(Baselines.toJSON(Baselines.firstDeploy())).toEqual({ kind: "first_deploy" });
    const existing = Baselines.toJSON(existingBaseline);
    expect(existing.commitSha).toBe(previousSha);
    expect(existing.upstream).toEqual({ host: "127.0.0.1", port: 3001 });
  });
});
