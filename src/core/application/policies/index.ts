/** Policies — the tunable decisions, as pure functions. */

export type { HealthDecision, HealthEvaluation } from "./health-policy";
export { NO_TIME_ELAPSED, evaluateHealth } from "./health-policy";

export type { RetentionInput } from "./retention-policy";
export { imagesToRemove } from "./retention-policy";

export { projectContainerName } from "./container-naming";

export {
  CAPTURED_LOG_LINES,
  MINIMUM_FREE_DISK_BYTES,
  PROBE_TIMEOUT,
  STOP_GRACE,
  THRESHOLD_MILLIS,
  hasEnoughDisk,
} from "./thresholds";
