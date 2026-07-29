/**
 * Display formatting.
 *
 * Pure functions over the read models' primitives, so the same duration reads the same way on
 * every screen. The application layer deliberately hands the UI epoch milliseconds and raw
 * millisecond durations rather than pre-formatted strings — locale and precision are a rendering
 * decision, and this is where it is made.
 */

/** `0.4s`, `1m 42s`, `2h 05m`. Compact enough for a table column, exact enough to compare. */
export function formatDuration(millis: number | undefined): string {
  if (millis === undefined) {
    return "—";
  }
  if (millis < 1000) {
    return `${Math.max(0, Math.round(millis))}ms`;
  }
  const totalSeconds = millis / 1000;
  if (totalSeconds < 60) {
    // One decimal below a minute: the difference between 0.4s and 1.2s is worth seeing.
    return `${totalSeconds < 10 ? totalSeconds.toFixed(1) : Math.round(totalSeconds)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  if (minutes < 60) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * `just now`, `4m ago`, `2h ago`, `3d ago`.
 *
 * Deliberately coarse. "2 hours ago" is what a reader wants when scanning; the exact instant
 * belongs in a `title` attribute for when they are reconstructing an incident.
 */
export function formatRelative(epochMillis: number, now = Date.now()): string {
  const seconds = Math.round((now - epochMillis) / 1000);
  if (seconds < 0) {
    return "just now";
  }
  if (seconds < 45) {
    return "just now";
  }
  if (seconds < 3600) {
    return `${Math.max(1, Math.round(seconds / 60))}m ago`;
  }
  if (seconds < 86_400) {
    return `${Math.round(seconds / 3600)}h ago`;
  }
  if (seconds < 2_592_000) {
    return `${Math.round(seconds / 86_400)}d ago`;
  }
  return new Date(epochMillis).toISOString().slice(0, 10);
}

/**
 * `2026-07-29 12:04:52 UTC` — the exact instant, for a `title` attribute and for reconstructing an
 * incident. Seconds, not milliseconds: nothing a reader does with this needs the last three digits,
 * and they are three digits of noise in a confirmation dialog.
 */
export function formatAbsolute(epochMillis: number): string {
  return `${new Date(epochMillis).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** `12:04:52` — the log gutter. Seconds matter, dates do not. */
export function formatClock(epochMillis: number): string {
  return new Date(epochMillis).toISOString().slice(11, 19);
}

/** Seven characters, the length every git tool agrees on. Display only, never identity. */
export function shortSha(sha: string | undefined): string {
  return sha === undefined ? "—" : sha.slice(0, 7);
}

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * A ref as a reader wants to see it.
 *
 * A rollback's target ref is the commit sha itself, and forty hex characters in a table column is
 * noise that pushes everything else out of alignment. Branch and tag names pass through untouched.
 */
export function formatRef(ref: string): string {
  return FULL_SHA.test(ref) ? shortSha(ref) : ref;
}

export interface TargetDescription {
  /** The monospace headline: the sha once it is known, the ref until then. */
  readonly primary: string;
  /** The phrase beside it, or `undefined` when it would only repeat the headline. */
  readonly qualifier: string | undefined;
}

/**
 * How to name what a deployment is deploying, without saying it twice.
 *
 * Three cases, and each of them appeared as a bug before this existed. A queued deployment has no
 * commit yet, so its ref *is* the headline and "master on master" is nonsense. A rollback's ref is
 * the sha itself, so "a3f9c21 on a3f9c21" is worse. And a branch name must never go through
 * `shortSha`, which would render `feature/checkout-v2` as `feature`.
 */
export function describeTarget(
  commitSha: string | undefined,
  targetRef: string,
): TargetDescription {
  if (commitSha === undefined) {
    return { primary: formatRef(targetRef), qualifier: undefined };
  }
  const short = shortSha(commitSha);
  return formatRef(targetRef) === short
    ? { primary: short, qualifier: "redeploying this commit" }
    : { primary: short, qualifier: `on ${formatRef(targetRef)}` };
}

/** `1.2 GB free of 100 GB`. Preflight is the only place this appears. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * An error code as a human phrase: `HEALTH_CHECK_FAILED` → `Health check failed`.
 *
 * The code stays visible next to it — it is the stable contract and the thing worth searching
 * for — but a screaming constant should never be the first thing a reader has to parse.
 */
export function humanizeCode(code: string): string {
  const words = code.toLowerCase().split("_");
  const [first, ...rest] = words;
  if (first === undefined) {
    return code;
  }
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}
