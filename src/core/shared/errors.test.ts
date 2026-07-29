// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ContainerPort } from "./container";
import { ERROR_CATALOG, ERROR_CLASSES, type ErrorCode, errorClassOf } from "./error-codes";
import { DeploymentError } from "./errors";
import { CommitSha, GitRef } from "./git";
import { err, ok, unwrapOrThrow } from "./result";
import { expectErr, expectOk } from "./result.testing";
import { asRecord, checkCrossField, combineFields } from "./validation";

describe("Result", () => {
  it("carries a value or an error, and nothing else", () => {
    expect(ok(2)).toEqual({ ok: true, value: 2 });
    const failure = DeploymentError.of("BUILD_FAILED", "nope");
    expect(err(failure)).toEqual({ ok: false, error: failure });
  });

  it("throws only through the explicit escape hatch", () => {
    expect(unwrapOrThrow(ok("value"))).toBe("value");
    expect(() => unwrapOrThrow(err(DeploymentError.of("BUILD_FAILED", "boom")))).toThrow(
      DeploymentError,
    );
  });
});

describe("the error catalog", () => {
  it("derives the class from the code so the two cannot disagree", () => {
    expect(DeploymentError.of("HEALTH_CHECK_FAILED", "x").errorClass).toBe("USER_CODE");
    expect(DeploymentError.of("DEPLOYMENT_IN_PROGRESS", "x").errorClass).toBe("PRECONDITION");
    expect(DeploymentError.of("ILLEGAL_STATE_TRANSITION", "x").errorClass).toBe("INTERNAL");
  });

  it("classifies every code as one of the declared classes", () => {
    for (const code of Object.keys(ERROR_CATALOG) as ErrorCode[]) {
      expect(ERROR_CLASSES, code).toContain(errorClassOf(code));
    }
  });

  it("contains no code without a producer", () => {
    // The catalog is limited to codes something actually raises. This count is a
    // deliberate tripwire, not a limit: adding a code should require updating it in the
    // same change, which is what makes a speculative addition visible in review.
    //
    // 49 after the domain layer; 58 after the application layer; 67 after the adapters
    // added command, docker, proxy, storage, secret-store, lock and git codes — each alongside
    // the code that raises it.
    expect(Object.keys(ERROR_CATALOG)).toHaveLength(67);
  });
});

describe("DeploymentError", () => {
  it("summarizes validation issues into the message", () => {
    const error = DeploymentError.validation("DEPLOY_CONFIG_INVALID", "Invalid config", [
      "targetRef: must not be empty",
      "containerPort: must be at least 1",
    ]);
    expect(error.issues).toHaveLength(2);
    expect(error.message).toContain("targetRef: must not be empty");
  });

  it("is immutable — attaching a step returns a copy", () => {
    const original = DeploymentError.of("BUILD_FAILED", "x");
    const withStep = original.withStep("build");
    expect(original.step).toBeUndefined();
    expect(withStep.step).toBe("build");
    expect(withStep).not.toBe(original);
  });

  it("freezes issues and details", () => {
    const error = DeploymentError.of("BUILD_FAILED", "x", {
      issues: ["a"],
      details: { attempt: 1 },
    });
    expect(Object.isFrozen(error.details)).toBe(true);
    expect(Object.isFrozen(error.issues)).toBe(true);
  });

  it("serializes to a stable shape", () => {
    const json = DeploymentError.of("BUILD_FAILED", "exit 1", { details: { code: 1 } })
      .withStep("build")
      .toJSON();
    expect(json).toEqual({
      name: "DeploymentError",
      code: "BUILD_FAILED",
      errorClass: "USER_CODE",
      message: "exit 1",
      issues: [],
      step: "build",
      details: { code: 1 },
    });
  });
});

describe("combineFields", () => {
  it("reports every bad field, not only the first", () => {
    const error = expectErr(
      combineFields("DEPLOY_CONFIG_INVALID", "Invalid config", {
        port: ContainerPort.parse(0),
        sha: CommitSha.parse("nope"),
        ref: GitRef.parse("main"),
      }),
    );
    expect(error.issues).toHaveLength(2);
    expect(error.issues.join(" ")).toContain("port");
    expect(error.issues.join(" ")).toContain("sha");
  });

  it("returns the parsed values when every field is valid", () => {
    const fields = expectOk(
      combineFields("DEPLOY_CONFIG_INVALID", "Invalid config", {
        port: ContainerPort.parse(3000),
        ref: GitRef.parse("main"),
      }),
    );
    expect(fields).toEqual({ port: 3000, ref: "main" });
  });

  it("prefixes a nested composite's issues with a readable path", () => {
    const nested = combineFields("DEPLOY_CONFIG_INVALID", "inner", {
      port: ContainerPort.parse(-1),
    });
    const error = expectErr(
      combineFields("DEPLOY_CONFIG_INVALID", "outer", { healthCheck: nested }),
    );
    expect(error.issues[0]).toContain("healthCheck.port");
  });
});

describe("asRecord and checkCrossField", () => {
  it("narrows only genuine property bags", () => {
    expect(expectOk(asRecord({ a: 1 }, "PROJECT_INVALID", "Project"))).toEqual({ a: 1 });
    for (const notARecord of [null, undefined, "string", 3, [1, 2]]) {
      expect(asRecord(notARecord, "PROJECT_INVALID", "Project").ok).toBe(false);
    }
  });

  it("passes a value through when there are no cross-field issues", () => {
    expect(expectOk(checkCrossField("PROJECT_INVALID", "m", "value", []))).toBe("value");
    expect(expectErr(checkCrossField("PROJECT_INVALID", "m", "value", ["bad"])).issues).toEqual([
      "bad",
    ]);
  });
});
