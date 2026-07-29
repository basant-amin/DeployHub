/**
 * The deployment state machine.
 *
 * This file is the transcription of `docs/architecture/deployment-engine.md` §
 * Lifecycle, and it is the only authority on what state a deployment may move to.
 * Nothing else in the platform may contain a list of states or a transition rule —
 * if a second list appears, the two will disagree, and the one that is wrong will be
 * the one running in production.
 *
 * Two structural properties fall out of the table below and are relied on
 * elsewhere: the graph is acyclic (no state is ever re-entered, so the transition
 * history is a clean audit trail), and every path terminates.
 */

import { type Result, DeploymentError, err, ok } from "@/core/shared";

export const DEPLOYMENT_STATES = [
  "queued",
  "validating",
  "preparing",
  "fetching",
  "building",
  "starting",
  "health_checking",
  "promoting",
  "finalizing",
  "rolling_back",
  "interrupted",
  "succeeded",
  "failed",
  "rolled_back",
  "canceled",
  "rollback_failed",
] as const;

export type DeploymentState = (typeof DEPLOYMENT_STATES)[number];

/**
 * Legal transitions, exactly as specified.
 *
 * `interrupted` is reachable from every active state because a worker can die at
 * any moment — that is the whole reason the state exists. It is not terminal: it
 * means the record and the server may disagree and the reconciler has not yet
 * decided which is right.
 */
export const TRANSITIONS: Readonly<Record<DeploymentState, readonly DeploymentState[]>> =
  Object.freeze({
    queued: Object.freeze(["validating", "canceled"] as const),
    validating: Object.freeze(["preparing", "failed", "interrupted"] as const),
    preparing: Object.freeze(["fetching", "failed", "canceled", "interrupted"] as const),
    // `succeeded` here is the no-op short circuit: the resolved sha is already live.
    fetching: Object.freeze([
      "building",
      "succeeded",
      "failed",
      "canceled",
      "interrupted",
    ] as const),
    building: Object.freeze(["starting", "failed", "canceled", "interrupted"] as const),
    starting: Object.freeze(["health_checking", "failed", "canceled", "interrupted"] as const),
    health_checking: Object.freeze(["promoting", "failed", "canceled", "interrupted"] as const),
    // No path to `failed`: once traffic has been switched, the failure response is a
    // rollback, not a bare failure.
    promoting: Object.freeze(["finalizing", "rolling_back", "interrupted"] as const),
    // No path to `failed`: the release is live and verified, so a finalization
    // problem is recorded as a warning (see `docs/architecture/deployment-engine.md`
    // § Degraded outcomes).
    finalizing: Object.freeze(["succeeded", "interrupted"] as const),
    rolling_back: Object.freeze(["rolled_back", "rollback_failed", "interrupted"] as const),
    interrupted: Object.freeze(["failed", "succeeded", "rollback_failed"] as const),
    succeeded: Object.freeze([] as const),
    failed: Object.freeze([] as const),
    rolled_back: Object.freeze([] as const),
    canceled: Object.freeze([] as const),
    rollback_failed: Object.freeze([] as const),
  });

type DeploymentStateKind = "pending" | "active" | "terminal";

const STATE_KINDS: Readonly<Record<DeploymentState, DeploymentStateKind>> = Object.freeze({
  queued: "pending",
  validating: "active",
  preparing: "active",
  fetching: "active",
  building: "active",
  starting: "active",
  health_checking: "active",
  promoting: "active",
  finalizing: "active",
  rolling_back: "active",
  interrupted: "active",
  succeeded: "terminal",
  failed: "terminal",
  rolled_back: "terminal",
  canceled: "terminal",
  rollback_failed: "terminal",
});

/**
 * What the deployment lock is doing in each state.
 *
 * - `not_acquired` — no lock yet; a failure here costs nothing.
 * - `held` — the lock is held and being renewed; mutation of the server is allowed.
 * - `expired` — the holder died; the reconciler will take over.
 * - `released` — the terminal state released it.
 * - `retained` — deliberately **not** released, so no further automation can stack
 *   onto an unknown server state. Only `rollback_failed`, which requires a human.
 */
export type LockDisposition = "not_acquired" | "held" | "expired" | "released" | "retained";

const LOCK_DISPOSITIONS: Readonly<Record<DeploymentState, LockDisposition>> = Object.freeze({
  queued: "not_acquired",
  validating: "not_acquired",
  preparing: "held",
  fetching: "held",
  building: "held",
  starting: "held",
  health_checking: "held",
  promoting: "held",
  finalizing: "held",
  rolling_back: "held",
  interrupted: "expired",
  succeeded: "released",
  failed: "released",
  rolled_back: "released",
  canceled: "released",
  rollback_failed: "retained",
});

/** Active means work is in flight or awaiting reconciliation. Not terminal. */
export function isActive(state: DeploymentState): boolean {
  return STATE_KINDS[state] === "active";
}

export function isTerminal(state: DeploymentState): boolean {
  return STATE_KINDS[state] === "terminal";
}

export function lockDisposition(state: DeploymentState): LockDisposition {
  return LOCK_DISPOSITIONS[state];
}

/** Invariant 2: no server mutation happens outside a held lock. */
export function requiresLock(state: DeploymentState): boolean {
  return LOCK_DISPOSITIONS[state] === "held";
}

/** Invariant 7: every terminal state releases the lock — except `rollback_failed`. */
export function releasesLock(state: DeploymentState): boolean {
  return LOCK_DISPOSITIONS[state] === "released";
}

export function canTransition(from: DeploymentState, to: DeploymentState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Guard a transition. `INTERNAL` rather than `VALIDATION`, deliberately: reaching
 * here means the engine attempted a move the lifecycle does not allow, which is a
 * bug in DeployHub rather than bad input, and it should page someone.
 */
export function assertTransition(from: DeploymentState, to: DeploymentState): Result<void> {
  if (canTransition(from, to)) {
    return ok(undefined);
  }
  const allowed = TRANSITIONS[from];
  return err(
    DeploymentError.of(
      "ILLEGAL_STATE_TRANSITION",
      allowed.length === 0
        ? `Cannot transition from terminal state "${from}" to "${to}"`
        : `Cannot transition from "${from}" to "${to}" (allowed: ${allowed.join(", ")})`,
      { details: { from, to, allowed } },
    ),
  );
}
