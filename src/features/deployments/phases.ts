/**
 * The rail, derived from the transition timeline.
 *
 * The engine records every state change with its timestamp, and the time a deployment spends *in* a
 * state is exactly the duration of the work that state represents. So the rail is derived rather
 * than stored — there is no second copy of timing to drift out of step with the first, and it works
 * retroactively for deployments that ran before this screen existed.
 *
 * (The aggregate also supports explicit step records, which the engine does not yet write. When it
 * does, they become a *refinement* of this — sub-steps inside a state — rather than a replacement.)
 */

import type { DeploymentDetail } from "@/core/application";
import type { DeploymentState } from "@/core/domain";

export interface Phase {
  readonly state: DeploymentState;
  readonly label: string;
  readonly at: number;
  /** Time spent in this state. Absent while it is still the current one. */
  readonly durationMillis: number | undefined;
  readonly status: "done" | "running" | "failed";
}

/** What the deployment was *doing* in each state, in the reader's words. */
const PHASE_LABELS: Partial<Record<DeploymentState, string>> = {
  validating: "Preflight",
  preparing: "Acquire lock",
  fetching: "Update source",
  building: "Build image",
  starting: "Start candidate",
  health_checking: "Health check",
  promoting: "Promote & verify",
  finalizing: "Finalize",
  rolling_back: "Roll back",
  interrupted: "Interrupted",
};

/** States that are outcomes rather than work — they end the rail instead of appearing in it. */
const TERMINAL: ReadonlySet<DeploymentState> = new Set<DeploymentState>([
  "succeeded",
  "failed",
  "rolled_back",
  "canceled",
  "rollback_failed",
]);

export function derivePhases(detail: DeploymentDetail): readonly Phase[] {
  const phases: Phase[] = [];

  for (const [index, entry] of detail.timeline.entries()) {
    if (TERMINAL.has(entry.state)) {
      continue;
    }
    const label = PHASE_LABELS[entry.state];
    if (label === undefined) {
      continue;
    }

    // The next transition closes this phase, whatever it was. If there is no next transition the
    // phase is still open — and only then is it running.
    const next = detail.timeline[index + 1];
    const closedAt = next?.at;
    const isLast = next === undefined;

    phases.push({
      state: entry.state,
      label,
      at: entry.at,
      durationMillis: closedAt === undefined ? undefined : closedAt - entry.at,
      status: isLast && detail.isActive ? "running" : failedHere(next) ? "failed" : "done",
    });
  }

  return phases;
}

/**
 * A phase is the failing one when the transition *out* of it went to a failure state.
 *
 * That is what makes the rail point at the cause: the step that was running when it went wrong,
 * rather than a red mark next to the outcome.
 */
function failedHere(next: DeploymentDetail["timeline"][number] | undefined): boolean {
  if (next === undefined) {
    return false;
  }
  return (
    next.state === "failed" || next.state === "rollback_failed" || next.state === "rolling_back"
  );
}

/** The phase a reader is most likely to want open. */
export function phaseOfInterest(phases: readonly Phase[]): Phase | undefined {
  return (
    phases.find((phase) => phase.status === "running") ??
    phases.find((phase) => phase.status === "failed") ??
    phases.reduce<Phase | undefined>(
      (slowest, phase) =>
        (phase.durationMillis ?? 0) > (slowest?.durationMillis ?? 0) ? phase : slowest,
      undefined,
    )
  );
}
