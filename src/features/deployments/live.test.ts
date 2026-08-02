// @vitest-environment node
import { describe, expect, it } from "vitest";

import { DEPLOYMENT_STATES } from "@/core/domain";

import {
  POLL_BACKOFF_AFTER_MILLIS,
  POLL_FAST_MILLIS,
  POLL_SLOW_MILLIS,
  isLive,
  pollDelay,
  previousReleaseStillServing,
} from "./live";

describe("pollDelay", () => {
  it("polls fast while something has changed recently", () => {
    expect(pollDelay(0)).toBe(POLL_FAST_MILLIS);
    expect(pollDelay(POLL_BACKOFF_AFTER_MILLIS - 1)).toBe(POLL_FAST_MILLIS);
  });

  it("backs off once nothing has changed for the quiet period", () => {
    expect(pollDelay(POLL_BACKOFF_AFTER_MILLIS)).toBe(POLL_SLOW_MILLIS);
    expect(pollDelay(10 * POLL_BACKOFF_AFTER_MILLIS)).toBe(POLL_SLOW_MILLIS);
  });
});

describe("isLive", () => {
  it("polls a queued deployment, which the domain calls pending rather than active", () => {
    expect(isLive("queued")).toBe(true);
  });

  it("polls every state where a worker is doing something", () => {
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
      expect(isLive(state), state).toBe(true);
    }
  });

  it("stops on every terminal state", () => {
    for (const state of [
      "succeeded",
      "failed",
      "rolled_back",
      "canceled",
      "rollback_failed",
    ] as const) {
      expect(isLive(state), state).toBe(false);
    }
  });

  it("does not poll an interrupted deployment, which cannot change on its own", () => {
    // The domain calls it active because it awaits reconciliation, but nothing will move it
    // without another deployment or a restart.
    expect(isLive("interrupted")).toBe(false);
  });

  it("has an answer for every state in the machine", () => {
    // A new state added to the domain must be classified deliberately, not defaulted.
    for (const state of DEPLOYMENT_STATES) {
      expect(typeof isLive(state), state).toBe("boolean");
    }
    expect(DEPLOYMENT_STATES.filter((state) => isLive(state))).toHaveLength(10);
  });
});

describe("previousReleaseStillServing", () => {
  it("is true only while nothing has been displaced", () => {
    for (const state of ["queued", "validating", "preparing", "fetching", "building"] as const) {
      expect(previousReleaseStillServing(state), state).toBe(true);
    }
  });

  it("is false from `starting` onward, where the previous container has been removed", () => {
    // The regression this exists for: saying "still live and serving traffic" during a
    // deployment that has already taken production down. `starting` is the boundary under the
    // classic strategy, and it moved here from `promoting` when the strategy changed (D12).
    for (const state of [
      "starting",
      "health_checking",
      "promoting",
      "finalizing",
      "rolling_back",
    ] as const) {
      expect(previousReleaseStillServing(state), state).toBe(false);
    }
  });

  it("never claims safety for a terminal or interrupted deployment", () => {
    for (const state of [
      "succeeded",
      "failed",
      "rolled_back",
      "canceled",
      "rollback_failed",
      "interrupted",
    ] as const) {
      expect(previousReleaseStillServing(state), state).toBe(false);
    }
  });

  it("has an answer for every state, and defaults a new one to unsafe", () => {
    for (const state of DEPLOYMENT_STATES) {
      expect(typeof previousReleaseStillServing(state), state).toBe("boolean");
    }
    expect(DEPLOYMENT_STATES.filter((state) => previousReleaseStillServing(state))).toHaveLength(5);
  });
});
