/**
 * When to poll, and how often.
 *
 * Pure functions, so the back-off rule is testable without a browser. The component that acts on
 * them is `components/live-refresh.tsx`.
 */

import { type DeploymentState, isTerminal } from "@/core/domain";

/** One second while something is happening. Fast enough that the log feels live. */
export const POLL_FAST_MILLIS = 1_000;

/** Three seconds once nothing has changed for a while. */
export const POLL_SLOW_MILLIS = 3_000;

/**
 * How long a deployment must go without producing anything new before polling slows down.
 *
 * Two minutes, because that is roughly the point at which a step has stopped being interactive and
 * become something you wait out — a long `docker build` with a quiet layer, most often. Backing off
 * costs at most two seconds of staleness on the transition out of it.
 */
export const POLL_BACKOFF_AFTER_MILLIS = 120_000;

export function pollDelay(millisSinceLastChange: number): number {
  return millisSinceLastChange >= POLL_BACKOFF_AFTER_MILLIS ? POLL_SLOW_MILLIS : POLL_FAST_MILLIS;
}

/**
 * Whether this deployment will change on its own, and therefore whether the page should poll.
 *
 * Deliberately not the domain's `isActive`, which answers a different question and gets both edges
 * wrong for this one:
 *
 * - `queued` is *pending*, not active, but it is precisely the state where a reader is waiting for
 *   something to happen.
 * - `interrupted` is active — it awaits reconciliation — but nothing on the server will move it
 *   without another deployment or a restart, so polling it would spend a request a second on a page
 *   that cannot change.
 */
export function isLive(state: DeploymentState): boolean {
  return !isTerminal(state) && state !== "interrupted";
}

/**
 * Whether the previous release is still running and still serving.
 *
 * The hero says so out loud while a deployment is in flight, which makes this the one derived
 * fact in the product that must never be optimistic. Under the classic strategy (D12) the
 * previous container is stopped and removed at `starting`, so the reassurance holds up to that
 * point and not one state further.
 *
 * Written as an allow-list of states rather than as "not one of these" so that a state added
 * later is treated as unsafe until someone decides otherwise. Getting this wrong in the other
 * direction tells a reader production is fine while their site is down.
 */
const BEFORE_DISPLACEMENT: readonly DeploymentState[] = [
  "queued",
  "validating",
  "preparing",
  "fetching",
  "building",
];

export function previousReleaseStillServing(state: DeploymentState): boolean {
  return BEFORE_DISPLACEMENT.includes(state);
}
