// @vitest-environment node
import { describe, expect, it } from "vitest";

import { expectErr, expectOk } from "./result.testing";
import { Duration, Timestamp } from "./time";

const early = expectOk(Timestamp.fromEpochMillis(1_000));
const late = expectOk(Timestamp.fromEpochMillis(4_500));

describe("Timestamp", () => {
  it("accepts whole non-negative milliseconds only", () => {
    expect(Timestamp.fromEpochMillis(0).ok).toBe(true);
    expect(Timestamp.fromEpochMillis(1.5).ok).toBe(false);
    expect(Timestamp.fromEpochMillis(-1).ok).toBe(false);
    expect(Timestamp.fromEpochMillis("2026-01-01").ok).toBe(false);
    expect(Timestamp.fromEpochMillis(Number.NaN).ok).toBe(false);
    expect(Timestamp.fromEpochMillis(8_640_000_000_000_001).ok).toBe(false);
  });

  it("measures elapsed time forwards only", () => {
    expect(expectOk(late.since(early)).millis).toBe(3_500);
    expect(expectOk(late.since(late)).millis).toBe(0);
    expect(expectErr(early.since(late)).code).toBe("NON_MONOTONIC_TIMESTAMP");
  });

  it("compares and picks the later instant", () => {
    expect(early.isBefore(late)).toBe(true);
    expect(late.isBefore(early)).toBe(false);
    expect(early.equals(expectOk(Timestamp.fromEpochMillis(1_000)))).toBe(true);
    expect(Timestamp.max(early, late)).toBe(late);
    expect(Timestamp.max(late, early)).toBe(late);
    expect(Timestamp.max(early, early)).toBe(early);
  });

  it("renders ISO 8601 for error messages", () => {
    expect(early.toISOString()).toBe("1970-01-01T00:00:01.000Z");
  });
});

describe("Duration", () => {
  it("accepts whole non-negative milliseconds only", () => {
    expect(expectOk(Duration.fromMillis(0)).millis).toBe(0);
    expect(Duration.fromMillis(-1).ok).toBe(false);
    expect(Duration.fromMillis(1.5).ok).toBe(false);
  });

  it("scales without an unreachable failure mode to swallow", () => {
    const second = expectOk(Duration.fromMillis(1_000));
    expect(second.times(3).millis).toBe(3_000);
    expect(second.times(0).millis).toBe(0);
    // A negative or fractional count is clamped rather than reported: callers pass a
    // repeat count, and there is no meaning to a fraction of one.
    expect(second.times(-5).millis).toBe(0);
    expect(second.times(2.7).millis).toBe(2_000);
  });

  it("compares", () => {
    const short = expectOk(Duration.fromMillis(100));
    const long = expectOk(Duration.fromMillis(900));
    expect(long.isLongerThan(short)).toBe(true);
    expect(short.isShorterThan(long)).toBe(true);
    expect(short.isLongerThan(short)).toBe(false);
    expect(short.equals(expectOk(Duration.fromMillis(100)))).toBe(true);
  });
});
