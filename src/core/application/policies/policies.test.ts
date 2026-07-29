// @vitest-environment node
import { describe, expect, it } from "vitest";

import { unwrapOrThrow } from "@/core/shared";
import { Duration } from "@/core/shared";
import { expectOk } from "@/core/shared/result.testing";
import { HealthCheckSpec, ImageRetention } from "@/core/domain";
import { driveTo, makeProject, releaseFrom } from "@/core/domain/deployments/deployment.fixtures";
import type { ProbeOutcome } from "@/core/ports";

import { deploymentContainerName } from "./container-naming";
import { evaluateHealth } from "./health-policy";
import { imagesToRemove } from "./retention-policy";
import { MINIMUM_FREE_DISK_BYTES, hasEnoughDisk } from "./thresholds";
import { shaOf } from "../engine/engine.fixtures";

const millis = (value: number) => unwrapOrThrow(Duration.fromMillis(value));

function spec(overrides: Readonly<Record<string, unknown>> = {}): HealthCheckSpec {
  return expectOk(
    HealthCheckSpec.create({
      path: "/healthz",
      expectedStatus: 200,
      intervalMillis: 1_000,
      requiredConsecutivePasses: 3,
      totalBudgetMillis: 10_000,
      ...overrides,
    }),
  );
}

function responded(status: number): ProbeOutcome {
  return { kind: "responded", status, latency: millis(5), bodyExcerpt: "" };
}

const unreachable: ProbeOutcome = {
  kind: "unreachable",
  latency: millis(5),
  reason: "connection refused",
};

describe("evaluateHealth", () => {
  it("passes once enough consecutive passes have arrived", () => {
    const decision = evaluateHealth({
      spec: spec(),
      attempts: [responded(200), responded(200), responded(200)],
      elapsed: millis(3_000),
    });
    expect(decision.kind).toBe("pass");
  });

  it("keeps waiting while there is budget left", () => {
    const decision = evaluateHealth({
      spec: spec(),
      attempts: [responded(200)],
      elapsed: millis(1_000),
    });
    expect(decision).toEqual({ kind: "retry", waitFor: spec().interval });
  });

  /**
   * The reason `requiredConsecutivePasses` exists. A service answering 200, 503, 200, 200
   * has passed three times and must still not be promoted.
   */
  it("does not promote a flapping service", () => {
    const decision = evaluateHealth({
      spec: spec(),
      attempts: [responded(200), responded(503), responded(200), responded(200)],
      elapsed: millis(4_000),
    });
    expect(decision.kind).toBe("retry");
  });

  it("counts only passes at the end of the run", () => {
    const decision = evaluateHealth({
      spec: spec(),
      attempts: [responded(200), responded(200), responded(200), unreachable],
      elapsed: millis(4_000),
    });
    expect(decision.kind).toBe("retry");
  });

  it("fails when the next attempt would fall outside the budget", () => {
    const decision = evaluateHealth({
      spec: spec(),
      attempts: [responded(503)],
      elapsed: millis(9_500),
    });
    expect(decision.kind).toBe("fail");
    if (decision.kind !== "fail") return;
    expect(decision.reason).toContain("expected 200");
    expect(decision.reason).toContain("0/3");
  });

  it("explains an unreachable target differently from a bad status", () => {
    const decision = evaluateHealth({
      spec: spec(),
      attempts: [unreachable],
      elapsed: millis(9_999),
    });
    expect(decision.kind).toBe("fail");
    if (decision.kind !== "fail") return;
    expect(decision.reason).toContain("did not reach the container");
    expect(decision.reason).toContain("connection refused");
  });

  it("passes on the first attempt when one pass is enough", () => {
    const decision = evaluateHealth({
      spec: spec({ requiredConsecutivePasses: 1 }),
      attempts: [responded(200)],
      elapsed: millis(0),
    });
    expect(decision.kind).toBe("pass");
  });

  it("respects a non-200 expected status", () => {
    const decision = evaluateHealth({
      spec: spec({ expectedStatus: 204, requiredConsecutivePasses: 1 }),
      attempts: [responded(200)],
      elapsed: millis(0),
    });
    expect(decision.kind).toBe("retry");
  });
});

describe("imagesToRemove", () => {
  const retention = expectOk(ImageRetention.parse(2));

  it("keeps the newest releases and removes the rest", () => {
    const releases = [
      releaseFrom("rel-00000001", shaOf("a")),
      releaseFrom("rel-00000002", shaOf("b")),
      releaseFrom("rel-00000003", shaOf("c")),
      releaseFrom("rel-00000004", shaOf("d")),
    ];

    const removed = imagesToRemove({ retention, releases, protectedDigests: [] });

    expect(removed).toHaveLength(2);
    expect(removed).toContain(releases[2]?.imageDigest);
    expect(removed).toContain(releases[3]?.imageDigest);
    expect(removed).not.toContain(releases[0]?.imageDigest);
  });

  it("removes nothing when there is less history than the retention window", () => {
    const releases = [releaseFrom("rel-00000001", shaOf("a"))];
    expect(imagesToRemove({ retention, releases, protectedDigests: [] })).toEqual([]);
  });

  it("never removes a protected digest, however old", () => {
    const releases = [
      releaseFrom("rel-00000001", shaOf("a")),
      releaseFrom("rel-00000002", shaOf("b")),
      releaseFrom("rel-00000003", shaOf("c")),
    ];
    const oldest = releases[2]?.imageDigest;
    expect(oldest).toBeDefined();
    if (oldest === undefined) return;

    const removed = imagesToRemove({ retention, releases, protectedDigests: [oldest] });
    expect(removed).toEqual([]);
  });

  it("de-duplicates a digest shared by two releases of the same commit", () => {
    const releases = [
      releaseFrom("rel-00000001", shaOf("a")),
      releaseFrom("rel-00000002", shaOf("b")),
      releaseFrom("rel-00000003", shaOf("c")),
      releaseFrom("rel-00000004", shaOf("c")),
    ];
    const removed = imagesToRemove({ retention, releases, protectedDigests: [] });
    expect(new Set(removed).size).toBe(removed.length);
  });
});

describe("deploymentContainerName", () => {
  it("is unique per deployment, so two can be on the host at once", () => {
    const project = makeProject();
    const first = expectOk(deploymentContainerName(project.slug, driveTo("queued").id));
    expect(first).toContain("one-community");
    expect(first).toContain(driveTo("queued").id);
  });
});

describe("hasEnoughDisk", () => {
  it("refuses below the threshold and allows at it", () => {
    expect(hasEnoughDisk(MINIMUM_FREE_DISK_BYTES)).toBe(true);
    expect(hasEnoughDisk(MINIMUM_FREE_DISK_BYTES - 1)).toBe(false);
    expect(hasEnoughDisk(0)).toBe(false);
  });
});
