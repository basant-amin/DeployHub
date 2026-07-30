/**
 * A deployment as plain text, for pasting somewhere else.
 *
 * This is the artefact an incident actually produces: a message in a channel, a comment on an issue, a
 * line in a postmortem. Screenshots of a dashboard are unsearchable and lossy, and "it failed, here's
 * the link" is useless to anyone without an account. So the product produces the paste itself, with
 * the facts in the order someone reading cold needs them: what happened, what it did to production,
 * why, and then the identifiers.
 *
 * A pure function of the read model, so it is tested rather than trusted.
 */

import type { DeploymentDetail } from "@/core/application";

import { formatClock, formatDuration, humanizeCode } from "@/lib/format";

/** How many log lines to include. Enough to see the failure, short enough to paste. */
const LOG_TAIL = 40;

export function diagnosticsText(detail: DeploymentDetail, route: string | undefined): string {
  const lines: string[] = [];

  lines.push(`DeployHub deployment ${detail.id}`);
  lines.push(
    `  state:    ${detail.state}${detail.outcome === undefined ? "" : ` (${detail.outcome})`}`,
  );
  lines.push(`  ref:      ${detail.targetRef}`);
  lines.push(`  commit:   ${detail.commitSha ?? "not resolved"}`);
  lines.push(`  trigger:  ${detail.trigger} by ${detail.actor}`);
  lines.push(`  started:  ${new Date(detail.requestedAt).toISOString()}`);
  lines.push(`  duration: ${formatDuration(detail.durationMillis)}`);
  if (route !== undefined) {
    lines.push(`  route:    ${route}`);
  }

  // The two independent proofs. Stating them separately is the point: a healthy container behind a
  // proxy pointing at a stale port is an outage that the first check calls a success.
  lines.push("");
  lines.push(
    `  container healthy:    ${detail.healthCheckPassedAt === undefined ? "no" : new Date(detail.healthCheckPassedAt).toISOString()}`,
  );
  lines.push(
    `  public route verified: ${detail.routeVerifiedAt === undefined ? "no" : new Date(detail.routeVerifiedAt).toISOString()}`,
  );

  if (detail.errorCode !== undefined) {
    lines.push("");
    lines.push(`Failure: ${humanizeCode(detail.errorCode)} [${detail.errorCode}]`);
    if (detail.errorMessage !== undefined) {
      lines.push(`  ${detail.errorMessage}`);
    }
  }

  if (detail.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of detail.warnings) {
      lines.push(`  [${warning.code}] ${warning.message}`);
    }
  }

  if (detail.imageReference !== undefined || detail.imageDigest !== undefined) {
    lines.push("");
    lines.push(`Image: ${detail.imageReference ?? "—"}`);
    lines.push(`Digest: ${detail.imageDigest ?? "—"}`);
  }

  lines.push("");
  lines.push("Timeline:");
  for (const entry of detail.timeline) {
    lines.push(
      `  ${formatClock(entry.at)}  ${entry.state}${entry.reason === undefined ? "" : ` — ${entry.reason}`}`,
    );
  }

  if (detail.logs.length > 0) {
    const tail = detail.logs.slice(-LOG_TAIL);
    lines.push("");
    lines.push(
      tail.length < detail.logs.length
        ? `Log (last ${tail.length} of ${detail.logs.length} lines):`
        : `Log (${tail.length} lines):`,
    );
    for (const line of tail) {
      lines.push(`  ${formatClock(line.at)}  [${line.step}] ${line.text}`);
    }
  }

  return lines.join("\n");
}

/** The whole log, unabridged, for the raw sheet's copy button. */
export function rawLogText(detail: DeploymentDetail): string {
  return detail.logs
    .map((line) => `${formatClock(line.at)}  ${line.step.padEnd(16)}  ${line.text}`)
    .join("\n");
}
