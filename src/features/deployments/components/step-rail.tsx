/**
 * The step rail and the trust checks.
 *
 * **No progress bar, and no percentage.** A deployment whose build takes 48s and whose promote
 * takes 0.4s cannot be honestly summarised by a single number, and a bar that jumps 0 → 70 → 71 →
 * 100 actively misleads. Durations per step are the only numbers here, and they are the truth.
 *
 * Both are pure Server Components. The rail re-renders when the polled page data changes; it holds
 * no state of its own.
 */

import { Check, Loader, Minus, X } from "lucide-react";

import type { DeploymentDetail } from "@/core/application";
import { Mono } from "@/components/ui/primitives";
import { type Phase, derivePhases } from "@/features/deployments/phases";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

export function PhaseRail({ detail }: { detail: DeploymentDetail }) {
  const phases = derivePhases(detail);

  if (phases.length === 0) {
    return (
      <p className="text-ink-3 px-4 py-6 text-[13px]">
        Waiting to start. Phases appear here as the worker moves through them.
      </p>
    );
  }

  return (
    <ol className="flex flex-col">
      {phases.map((phase) => (
        <li key={`${phase.state}-${phase.at}`}>
          <RailEntry phase={phase} />
        </li>
      ))}
    </ol>
  );
}

function RailEntry({ phase }: { phase: Phase }) {
  return (
    <div
      className={cn("flex items-center gap-3 px-4 py-2", phase.status === "failed" && "bg-bad-bg")}
    >
      <PhaseIcon status={phase.status} />
      <span
        className={cn(
          "flex-1 truncate text-[13px]",
          phase.status === "running" && "text-ink",
          phase.status === "failed" && "text-bad font-medium",
          phase.status === "done" && "text-ink-2",
        )}
      >
        {phase.label}
      </span>
      <Mono className="text-ink-3 shrink-0">
        {phase.status === "running" ? "running" : formatDuration(phase.durationMillis)}
      </Mono>
    </div>
  );
}

function PhaseIcon({ status }: { status: Phase["status"] }) {
  const shared = "size-3.5 shrink-0";
  if (status === "done") {
    return <Check className={cn(shared, "text-ok")} aria-label="done" />;
  }
  if (status === "failed") {
    return <X className={cn(shared, "text-bad")} aria-label="failed" />;
  }
  return <Loader className={cn(shared, "animate-pulse-dot text-run")} aria-label="running" />;
}

/* -- Trust checks -------------------------------------------------------- */

/**
 * The two independent proofs that a release actually works, promoted to the page header.
 *
 * They exist because the platform probes twice for different reasons: once at the container, which
 * proves the application runs, and once through the public route, which proves the routing does. A
 * correct container behind a proxy pointing at a stale port is a complete outage that the first
 * check reports as success.
 *
 * Most tools show one tick meaning "the pipeline exited zero". Showing both, separately, is the
 * clearest available statement of *what was actually proven*.
 */
export function TrustChecks({ detail }: { detail: DeploymentDetail }) {
  if (detail.outcome === "no_change") {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
      <TrustCheck
        label="Container healthy"
        passed={detail.healthCheckPassedAt !== undefined}
        pendingLabel="not yet verified"
      />
      <TrustCheck
        label="Public route verified"
        passed={detail.routeVerifiedAt !== undefined}
        pendingLabel="not yet verified"
      />
    </div>
  );
}

function TrustCheck({
  label,
  passed,
  pendingLabel,
}: {
  label: string;
  passed: boolean;
  pendingLabel: string;
}) {
  return (
    <span className="inline-flex items-center gap-2 text-[13px]">
      {passed ? (
        <Check className="text-ok size-3.5" aria-hidden />
      ) : (
        <Minus className="text-ink-3 size-3.5" aria-hidden />
      )}
      <span className={passed ? "text-ink-2" : "text-ink-3"}>
        {label}
        {!passed && <span className="text-ink-3"> · {pendingLabel}</span>}
      </span>
    </span>
  );
}
