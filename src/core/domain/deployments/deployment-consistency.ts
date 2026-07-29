/**
 * Consistency rules for a stored deployment.
 *
 * `Deployment.rehydrate` re-checks every rule here before reconstituting a record.
 * Persistence hands over already-parsed value objects; what this verifies is that
 * they form a *coherent* deployment — the transition history is legal, the fields a
 * state requires are present, timestamps move forward. A row corrupted by a bad
 * migration or an out-of-band write is rejected here rather than resuming as a
 * deployment that skipped its health check.
 *
 * Extracted from the aggregate so that the lifecycle and the audit of the lifecycle
 * can be read separately, and so that adding an invariant means editing one list.
 *
 * Every rule returns an issue rather than throwing on the first, because a corrupted
 * record should be reported completely — diagnosing one means seeing the whole
 * picture.
 */

import { Timestamp } from "@/core/shared";

import type { DeploymentSnapshot } from "./deployment";
import {
  type DeploymentState,
  assertTransition,
  isActive,
  isTerminal,
  requiresLock,
} from "./deployment-state";

export function consistencyIssues(fields: DeploymentSnapshot): readonly string[] {
  const issues: string[] = [];
  const { state, transitions } = fields;

  // -- The transition chain must be a legal, acyclic, forward-moving path.
  const last = transitions.at(-1);
  if (last === undefined) {
    if (state !== "queued") {
      issues.push(`state is "${state}" but no transitions are recorded`);
    }
  } else if (last.to !== state) {
    issues.push(`state is "${state}" but the last transition ended in "${last.to}"`);
  }

  const seen = new Set<DeploymentState>(["queued"]);
  let previousTo: DeploymentState = "queued";
  let previousAt = fields.requestedAt;

  for (const [index, transition] of transitions.entries()) {
    if (transition.from !== previousTo) {
      issues.push(
        `transition ${index} starts from "${transition.from}" but the previous state was "${previousTo}"`,
      );
    }
    if (!assertTransition(transition.from, transition.to).ok) {
      issues.push(`transition ${index} from "${transition.from}" to "${transition.to}" is illegal`);
    }
    if (seen.has(transition.to)) {
      issues.push(`state "${transition.to}" is entered more than once`);
    }
    if (transition.at.isBefore(previousAt)) {
      issues.push(
        `transition ${index} at ${transition.at.toISOString()} precedes the previous event at ${previousAt.toISOString()}`,
      );
    }
    seen.add(transition.to);
    previousTo = transition.to;
    previousAt = Timestamp.max(previousAt, transition.at);
  }

  const reached = (target: DeploymentState): boolean =>
    target === "queued" || transitions.some((t) => t.to === target);

  // -- Invariant 2: a state that mutates the server holds a fencing epoch.
  if (requiresLock(state) && fields.lockEpoch === undefined) {
    issues.push(`state "${state}" requires a held lock but no lock epoch is recorded`);
  }
  if ((state === "queued" || state === "validating") && fields.lockEpoch !== undefined) {
    issues.push(`state "${state}" precedes lock acquisition but a lock epoch is recorded`);
  }

  // -- Invariant 3: nothing is built without a rollback target.
  if (reached("building")) {
    if (fields.baseline === undefined) {
      issues.push("reached building without a captured baseline");
    }
    if (fields.resolvedSha === undefined) {
      issues.push("reached building without a resolved commit sha");
    }
  }
  if (reached("starting") && (fields.image === undefined || fields.imageDigest === undefined)) {
    issues.push("reached starting without a built image and digest");
  }
  if (reached("health_checking") && fields.candidate === undefined) {
    issues.push("reached health_checking without a candidate container");
  }

  // -- Invariant 4: promotion requires a passed health check, and *reporting a
  // -- deployed success* requires verification through the public route. The second
  // -- clause closes the reconciler's path to `succeeded`, which reaches it from
  // -- `interrupted` without passing through `finalizing`.
  if (reached("promoting") && fields.healthCheckPassedAt === undefined) {
    issues.push("reached promoting without a passed health check");
  }
  if (reached("finalizing") && fields.routeVerifiedAt === undefined) {
    issues.push("reached finalizing without route verification");
  }
  if (
    state === "succeeded" &&
    fields.outcome === "deployed" &&
    fields.routeVerifiedAt === undefined
  ) {
    issues.push("reports a deployed success without verification through the public route");
  }

  // -- Invariant 8: no failure without a code.
  if ((state === "failed" || state === "rollback_failed") && fields.error === undefined) {
    issues.push(`state "${state}" requires a recorded error`);
  }

  if (state === "succeeded") {
    if (fields.outcome === undefined) {
      issues.push("a succeeded deployment must record an outcome");
    } else if (fields.outcome === "deployed" && fields.candidate === undefined) {
      issues.push("a deployed deployment must record the container it shipped");
    }
  } else if (fields.outcome !== undefined) {
    issues.push(`state "${state}" must not record an outcome`);
  }

  if (state === "interrupted") {
    const from = fields.interruptedFrom;
    if (from === undefined) {
      issues.push("an interrupted deployment must record the state it was interrupted from");
    } else if (!isActive(from) || from === "interrupted") {
      issues.push(`interruptedFrom "${from}" is not an interruptible state`);
    }
  }

  if (isTerminal(state) && fields.finishedAt === undefined) {
    issues.push(`terminal state "${state}" must record when it finished`);
  }
  if (!isTerminal(state) && fields.finishedAt !== undefined) {
    issues.push(`non-terminal state "${state}" must not record a finish time`);
  }

  return issues;
}
