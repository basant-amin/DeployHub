// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { DeploymentDetail } from "@/core/application";

import { diagnosticsText, rawLogText } from "./diagnostics";

const START = Date.UTC(2026, 6, 29, 12, 4, 52);

/** A read model is plain data, so a fixture is a literal rather than a builder. */
function detail(overrides: Partial<DeploymentDetail> = {}): DeploymentDetail {
  return {
    id: "dep-6ca7a32bd5854dd8b090ca61c40dea2f",
    projectId: "prj-one-community",
    state: "failed",
    outcome: undefined,
    trigger: "manual",
    actor: "basant@elemta.com",
    targetRef: "main",
    commitSha: "bbed28cb775515c10d98d8e807aae4ac06e0fa8c",
    requestedAt: START,
    finishedAt: START + 33_000,
    durationMillis: 33_000,
    errorCode: "HEALTH_CHECK_FAILED",
    errorMessage: "candidate did not pass within 30000ms",
    warningCount: 0,
    imageReference: "deployhub/one-community:bbed28c",
    imageDigest: "sha256:198c3692673b7b298a11c7bd8583b6187905a6b2c",
    isFirstDeploy: false,
    healthCheckPassedAt: undefined,
    routeVerifiedAt: undefined,
    currentStep: undefined,
    isActive: false,
    timeline: [
      { state: "queued", at: START, reason: undefined },
      { state: "building", at: START + 2_000, reason: undefined },
      { state: "failed", at: START + 33_000, reason: "health check did not pass" },
    ],
    steps: [],
    warnings: [],
    logs: [
      { at: START + 2_100, step: "build", stream: "stdout", text: "building bbed28c" },
      { at: START + 30_000, step: "health_check", stream: "stderr", text: "connection refused" },
    ],
    ...overrides,
  };
}

describe("diagnosticsText", () => {
  it("leads with what happened, not with identifiers", () => {
    const [first, second] = diagnosticsText(detail(), "app.example.com").split("\n");
    expect(first).toContain("dep-6ca7a32bd5854dd8b090ca61c40dea2f");
    expect(second).toContain("state:");
    expect(second).toContain("failed");
  });

  it("states the two proofs separately, because they prove different things", () => {
    // A healthy container behind a proxy pointing at a stale port is an outage the first check calls
    // a success. Collapsing them into one tick would hide exactly that.
    const text = diagnosticsText(detail(), "app.example.com");
    expect(text).toContain("container healthy:    no");
    expect(text).toContain("public route verified: no");
  });

  it("records both proofs as instants once they pass", () => {
    const text = diagnosticsText(
      detail({ healthCheckPassedAt: START + 10_000, routeVerifiedAt: START + 12_000 }),
      "app.example.com",
    );
    expect(text).toContain("container healthy:    2026-07-29T12:05:02.000Z");
    expect(text).toContain("public route verified: 2026-07-29T12:05:04.000Z");
  });

  it("gives the failure a readable name and keeps the searchable code", () => {
    const text = diagnosticsText(detail(), undefined);
    expect(text).toContain("Failure: Health check failed [HEALTH_CHECK_FAILED]");
    expect(text).toContain("candidate did not pass within 30000ms");
  });

  it("omits the failure section entirely on a success", () => {
    const text = diagnosticsText(
      detail({
        state: "succeeded",
        outcome: "deployed",
        errorCode: undefined,
        errorMessage: undefined,
      }),
      undefined,
    );
    expect(text).not.toContain("Failure:");
    expect(text).toContain("state:    succeeded (deployed)");
  });

  it("includes the timeline, which is where the time actually went", () => {
    const text = diagnosticsText(detail(), undefined);
    expect(text).toContain("12:04:52  queued");
    expect(text).toContain("12:05:25  failed — health check did not pass");
  });

  it("lists warnings when there are any", () => {
    const text = diagnosticsText(
      detail({
        warningCount: 1,
        warnings: [
          {
            code: "IMAGE_PRUNE_FAILED",
            message: "could not remove 2 images",
            step: "finalize",
            at: START,
          },
        ],
      }),
      undefined,
    );
    expect(text).toContain("[IMAGE_PRUNE_FAILED] could not remove 2 images");
  });

  it("truncates a long log and says so, so nobody thinks they have the whole thing", () => {
    const many = Array.from({ length: 100 }, (_, index) => ({
      at: START + index,
      step: "build" as const,
      stream: "stdout" as const,
      text: `line ${index}`,
    }));
    const text = diagnosticsText(detail({ logs: many }), undefined);

    expect(text).toContain("Log (last 40 of 100 lines):");
    // The tail is what matters: a failure is at the end.
    expect(text).toContain("line 99");
    expect(text).not.toContain("line 59");
  });

  it("does not claim truncation when the whole log fits", () => {
    expect(diagnosticsText(detail(), undefined)).toContain("Log (2 lines):");
  });

  it("omits the route when there is nothing to say", () => {
    expect(diagnosticsText(detail(), undefined)).not.toContain("route:");
  });
});

describe("rawLogText", () => {
  it("is one aligned line per entry, with the step visible", () => {
    expect(rawLogText(detail()).split("\n")).toEqual([
      "12:04:54  build             building bbed28c",
      "12:05:22  health_check      connection refused",
    ]);
  });

  it("is empty rather than a placeholder when there is no output", () => {
    expect(rawLogText(detail({ logs: [] }))).toBe("");
  });
});
