/**
 * The deployment list.
 *
 * A list of links, not a table. There are no bulk operations on deployments and never should be,
 * so there is nothing for checkboxes, sort controls, or column headers to do — and a table
 * without them is just a list wearing a costume.
 *
 * Entirely server-rendered apart from the timestamp.
 */

import Link from "next/link";
import { ChevronRight } from "lucide-react";

import type { DeploymentSummary } from "@/core/application";
import { EmptyState, Mono } from "@/components/ui/primitives";
import { StatusDot, statusMeta } from "@/components/ui/status";
import { formatDuration, formatRef, formatRelative, shortSha } from "@/lib/format";
import { cn } from "@/lib/utils";

import { RelativeTime } from "./relative-time";

export function DeploymentList({
  deployments,
  emptyAction,
}: {
  deployments: readonly DeploymentSummary[];
  emptyAction?: React.ReactNode;
}) {
  if (deployments.length === 0) {
    return (
      <EmptyState
        title="No deployments yet"
        description="When you deploy, every attempt appears here with its outcome, duration and log."
        action={emptyAction}
      />
    );
  }

  return (
    <ul className="divide-line divide-y">
      {deployments.map((deployment) => (
        <li key={deployment.id}>
          <DeploymentRow deployment={deployment} />
        </li>
      ))}
    </ul>
  );
}

function DeploymentRow({ deployment }: { deployment: DeploymentSummary }) {
  const meta = statusMeta(deployment.state, deployment.outcome);
  const timestamp = deployment.finishedAt ?? deployment.requestedAt;

  return (
    <Link
      href={`/deployments/${deployment.id}`}
      className={cn(
        "group grid grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-3.5 transition-colors duration-100 sm:grid-cols-[168px_88px_1fr_auto_auto_20px] sm:gap-x-5",
        "hover:bg-raised",
        // `rollback_failed` is the one state allowed to shout, and it shouts from the row itself.
        deployment.state === "rollback_failed" && "bg-bad-bg-strong hover:bg-bad-bg-strong/80",
      )}
    >
      {/* Status: dot plus word. The word is what makes the dot unambiguous. */}
      <span className="col-start-1 row-start-1 flex items-center gap-2 text-[13px] font-medium">
        <StatusDot meta={meta} />
        <span
          className={cn(
            meta.tone === "ok" && "text-ok",
            meta.tone === "run" && "text-run",
            meta.tone === "warn" && "text-warn",
            meta.tone === "bad" && "text-bad",
            meta.tone === "idle" && "text-ink-2",
            meta.tone === "mute" && "text-ink-3",
          )}
        >
          {meta.label}
        </span>
      </span>

      {/* The sha only. A branch name would be truncated to seven characters here, and it already has
          its own column to the right. An em dash means "not resolved yet", which is the truth. */}
      <Mono className="text-ink col-start-2 row-start-1" title={deployment.commitSha}>
        {shortSha(deployment.commitSha)}
      </Mono>

      {/* Ref and actor: context, deliberately quiet. */}
      <span className="text-ink-2 col-span-2 col-start-1 row-start-2 truncate text-[13px] sm:col-span-1 sm:col-start-3 sm:row-start-1">
        {formatRef(deployment.targetRef)}
        <span className="text-ink-3"> · </span>
        {deployment.actor}
        {deployment.trigger === "rollback" && (
          <span className="border-line bg-raised text-ink-2 ml-2 rounded-sm border px-1.5 py-0.5 text-[11px]">
            rollback
          </span>
        )}
      </span>

      <Mono className="text-ink-2 col-start-3 row-start-1 justify-self-end sm:col-start-4">
        {formatDuration(deployment.durationMillis)}
      </Mono>

      <RelativeTime
        epochMillis={timestamp}
        initial={formatRelative(timestamp)}
        className="text-ink-3 col-start-3 row-start-2 justify-self-end font-mono text-[13px] sm:col-start-5 sm:row-start-1"
      />

      <ChevronRight
        className="text-ink-3 group-hover:text-ink-2 hidden transition-colors duration-100 sm:col-start-6 sm:block"
        aria-hidden
      />
    </Link>
  );
}
