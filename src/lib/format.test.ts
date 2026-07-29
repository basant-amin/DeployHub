// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  describeTarget,
  formatAbsolute,
  formatBytes,
  formatClock,
  formatDuration,
  formatRelative,
  humanizeCode,
  shortSha,
} from "./format";

describe("formatDuration", () => {
  it("keeps one decimal below ten seconds, where the difference is worth seeing", () => {
    expect(formatDuration(420)).toBe("420ms");
    expect(formatDuration(1_200)).toBe("1.2s");
    expect(formatDuration(9_940)).toBe("9.9s");
  });

  it("drops to whole seconds, then minutes, then hours", () => {
    expect(formatDuration(38_400)).toBe("38s");
    expect(formatDuration(102_000)).toBe("1m 42s");
    expect(formatDuration(3_726_000)).toBe("1h 02m");
  });

  it("renders an unknown duration as a dash rather than zero", () => {
    expect(formatDuration(undefined)).toBe("—");
  });
});

describe("formatRelative", () => {
  const now = Date.UTC(2026, 6, 29, 12, 0, 0);

  it("is coarse on purpose", () => {
    expect(formatRelative(now - 5_000, now)).toBe("just now");
    expect(formatRelative(now - 240_000, now)).toBe("4m ago");
    expect(formatRelative(now - 7_200_000, now)).toBe("2h ago");
    expect(formatRelative(now - 172_800_000, now)).toBe("2d ago");
  });

  it("falls back to a date once relative stops being useful", () => {
    expect(formatRelative(Date.UTC(2026, 0, 2), now)).toBe("2026-01-02");
  });

  it("never renders a negative age from clock skew", () => {
    expect(formatRelative(now + 60_000, now)).toBe("just now");
  });
});

describe("the exact forms", () => {
  it("gives full precision for incident forensics", () => {
    expect(formatAbsolute(Date.UTC(2026, 6, 29, 12, 4, 52))).toBe("2026-07-29 12:04:52 UTC");
  });

  it("drops milliseconds, which are noise everywhere it appears", () => {
    expect(formatAbsolute(Date.UTC(2026, 6, 29, 12, 4, 52) + 66)).toBe("2026-07-29 12:04:52 UTC");
  });

  it("gives seconds-only for the log gutter", () => {
    expect(formatClock(Date.UTC(2026, 6, 29, 12, 4, 52))).toBe("12:04:52");
  });

  it("shortens a sha for display and a dash for none", () => {
    expect(shortSha("a3f9c2199b1e4f0d")).toBe("a3f9c21");
    expect(shortSha(undefined)).toBe("—");
  });

  it("formats free space", () => {
    expect(formatBytes(0)).toBe("0.0 B");
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.0 GB");
  });
});

describe("humanizeCode", () => {
  it("turns a screaming constant into a phrase, keeping the code visible elsewhere", () => {
    expect(humanizeCode("HEALTH_CHECK_FAILED")).toBe("Health check failed");
    expect(humanizeCode("ROUTE_VERIFICATION_FAILED")).toBe("Route verification failed");
    expect(humanizeCode("")).toBe("");
  });
});

describe("describeTarget", () => {
  const sha = "bbed28cb775515c10d98d8e807aae4ac06e0fa8c";

  it("makes the ref the headline while the commit is unresolved, with nothing beside it", () => {
    // "master on master" was the bug this exists to prevent.
    expect(describeTarget(undefined, "master")).toEqual({
      primary: "master",
      qualifier: undefined,
    });
  });

  it("never runs a branch name through shortSha", () => {
    expect(describeTarget(undefined, "feature/checkout-v2").primary).toBe("feature/checkout-v2");
  });

  it("puts the sha first and the branch beside it once resolved", () => {
    expect(describeTarget(sha, "master")).toEqual({
      primary: "bbed28c",
      qualifier: "on master",
    });
  });

  it("does not repeat itself when the ref is the sha, as it is on a rollback", () => {
    expect(describeTarget(sha, sha)).toEqual({
      primary: "bbed28c",
      qualifier: "redeploying this commit",
    });
  });
});
