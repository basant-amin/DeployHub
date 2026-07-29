// @vitest-environment node
import { describe, expect, it } from "vitest";

import { expectErr } from "@/core/shared/result.testing";

import {
  DEPLOYMENT_STATES,
  type DeploymentState,
  TRANSITIONS,
  assertTransition,
  canTransition,
  isActive,
  isTerminal,
  lockDisposition,
  releasesLock,
  requiresLock,
} from "./deployment-state";

const TERMINAL_STATES: readonly DeploymentState[] = [
  "succeeded",
  "failed",
  "rolled_back",
  "canceled",
  "rollback_failed",
];

describe("the state machine's structure", () => {
  it("declares a transition list for every state and nothing else", () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...DEPLOYMENT_STATES].sort());
  });

  it("only ever names real states", () => {
    const known = new Set<string>(DEPLOYMENT_STATES);
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      expect(known.has(from), from).toBe(true);
      for (const to of targets) {
        expect(known.has(to), `${from} -> ${to}`).toBe(true);
      }
    }
  });

  it("is acyclic, which is what makes the transition history an audit trail", () => {
    const visiting = new Set<DeploymentState>();
    const done = new Set<DeploymentState>();
    const cycles: string[] = [];

    const walk = (state: DeploymentState, path: readonly DeploymentState[]): void => {
      if (visiting.has(state)) {
        cycles.push([...path, state].join(" -> "));
        return;
      }
      if (done.has(state)) {
        return;
      }
      visiting.add(state);
      for (const next of TRANSITIONS[state]) {
        walk(next, [...path, state]);
      }
      visiting.delete(state);
      done.add(state);
    };

    walk("queued", []);
    expect(cycles).toEqual([]);
  });

  it("has exactly the five terminal states, all of them sinks", () => {
    const sinks = DEPLOYMENT_STATES.filter((state) => TRANSITIONS[state].length === 0);
    expect([...sinks].sort()).toEqual([...TERMINAL_STATES].sort());
    for (const state of TERMINAL_STATES) {
      expect(isTerminal(state), state).toBe(true);
      expect(isActive(state), state).toBe(false);
    }
  });

  it("reaches every state from queued", () => {
    const reachable = new Set<DeploymentState>(["queued"]);
    const queue: DeploymentState[] = ["queued"];
    while (queue.length > 0) {
      const state = queue.shift() as DeploymentState;
      for (const next of TRANSITIONS[state]) {
        if (!reachable.has(next)) {
          reachable.add(next);
          queue.push(next);
        }
      }
    }
    expect([...reachable].sort()).toEqual([...DEPLOYMENT_STATES].sort());
  });
});

describe("the promotion boundary", () => {
  it("never allows promotion without a health check state before it", () => {
    for (const state of DEPLOYMENT_STATES) {
      if (canTransition(state, "promoting")) {
        expect(state).toBe("health_checking");
      }
    }
  });

  it("does not allow a bare failure once traffic has been switched", () => {
    expect(canTransition("promoting", "failed")).toBe(false);
    expect(canTransition("promoting", "rolling_back")).toBe(true);
    expect(canTransition("finalizing", "failed")).toBe(false);
  });

  it("does not allow cancellation during or after promotion", () => {
    for (const state of ["promoting", "finalizing", "rolling_back"] as const) {
      expect(canTransition(state, "canceled"), state).toBe(false);
    }
  });
});

describe("lock disposition", () => {
  it("requires no lock before it is acquired", () => {
    expect(requiresLock("queued")).toBe(false);
    expect(requiresLock("validating")).toBe(false);
    expect(lockDisposition("queued")).toBe("not_acquired");
  });

  it("holds the lock through every state that mutates the server", () => {
    for (const state of [
      "preparing",
      "fetching",
      "building",
      "starting",
      "health_checking",
      "promoting",
      "finalizing",
      "rolling_back",
    ] as const) {
      expect(requiresLock(state), state).toBe(true);
    }
  });

  it("releases the lock in every terminal state but rollback_failed", () => {
    for (const state of TERMINAL_STATES) {
      expect(releasesLock(state), state).toBe(state !== "rollback_failed");
    }
    expect(lockDisposition("rollback_failed")).toBe("retained");
  });

  it("treats an interrupted deployment's lease as expired", () => {
    expect(lockDisposition("interrupted")).toBe("expired");
    expect(requiresLock("interrupted")).toBe(false);
  });
});

describe("assertTransition", () => {
  it("permits a declared move", () => {
    expect(assertTransition("queued", "validating").ok).toBe(true);
  });

  it("rejects an undeclared move as an internal error, since it is a bug", () => {
    const error = expectErr(assertTransition("building", "promoting"));
    expect(error.code).toBe("ILLEGAL_STATE_TRANSITION");
    expect(error.errorClass).toBe("INTERNAL");
    expect(error.message).toContain("allowed:");
  });

  it("explains that a terminal state has nowhere to go", () => {
    expect(expectErr(assertTransition("succeeded", "building")).message).toContain(
      "terminal state",
    );
  });
});
