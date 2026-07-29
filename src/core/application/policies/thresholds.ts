/**
 * Every tunable number in the platform, in one findable place.
 *
 * These are platform policy, not per-project configuration: a project chooses its own
 * health check because applications differ, but nothing about One Community makes it
 * want a different stop grace period than the next project. Anything genuinely
 * per-project lives on `DeployConfig`.
 *
 * Timeouts are notably absent. Enforcing them is an adapter obligation — a command
 * runner bounds every command it runs, and `HealthProbe` takes a per-attempt timeout —
 * so the engine needs no timeout machinery of its own. Putting a second timeout layer
 * in the engine would be two mechanisms racing to report the same hang.
 */

import { Duration, unwrapOrThrow } from "@/core/shared";

/** Millisecond constants, exported so tests can assert against them by name. */
export const THRESHOLD_MILLIS = {
  /** How long a container gets to shut down cleanly before it is forced. */
  stopGrace: 10_000,
  /** Per-attempt budget for one health probe. */
  probeTimeout: 5_000,
} as const;

/** Free space below which a deployment is refused rather than risking a full disk. */
export const MINIMUM_FREE_DISK_BYTES = 2 * 1024 * 1024 * 1024;

/** Lines of container output captured when a candidate fails to become healthy. */
export const CAPTURED_LOG_LINES = 200;

export const STOP_GRACE: Duration = unwrapOrThrow(Duration.fromMillis(THRESHOLD_MILLIS.stopGrace));
export const PROBE_TIMEOUT: Duration = unwrapOrThrow(
  Duration.fromMillis(THRESHOLD_MILLIS.probeTimeout),
);

/**
 * Whether the host has room to build.
 *
 * A build that fills the disk can take the live container down with it, which makes
 * this the one preflight check that protects something already running.
 */
export function hasEnoughDisk(freeBytes: number): boolean {
  return freeBytes >= MINIMUM_FREE_DISK_BYTES;
}
