/**
 * The single owner of "deployment state → how it looks and what it is called".
 *
 * Nothing else in the UI may hard-code a status colour or invent a label. Two screens that
 * disagree about what amber means are worse than either screen alone, and this is the file that
 * makes disagreement impossible.
 *
 * Colour never carries meaning alone — roughly one in twelve men cannot reliably separate the
 * green from the amber — so every status also has a distinct glyph and an explicit word.
 */

import type { DeploymentOutcome, DeploymentState } from "@/core/domain";
import { cn } from "@/lib/utils";

export type StatusTone = "ok" | "run" | "warn" | "bad" | "idle" | "mute";

export interface StatusMeta {
  readonly tone: StatusTone;
  readonly label: string;
  /** Read by a screen reader in place of the glyph. */
  readonly glyph: string;
  /** Whether the dot pulses. Only true while work is genuinely in flight. */
  readonly live: boolean;
}

const ACTIVE_LABELS: Partial<Record<DeploymentState, string>> = {
  validating: "Checking",
  preparing: "Preparing",
  fetching: "Fetching source",
  building: "Building",
  starting: "Starting",
  health_checking: "Health checking",
  promoting: "Promoting",
  finalizing: "Finalizing",
  rolling_back: "Rolling back",
};

/**
 * `no_change` deserves its own appearance.
 *
 * It is a success in the state machine and *not* a success in any sense the reader cares about:
 * nothing shipped. Calling it "Succeeded" erodes trust in the word everywhere else.
 */
export function statusMeta(state: DeploymentState, outcome?: DeploymentOutcome): StatusMeta {
  switch (state) {
    case "succeeded":
      return outcome === "no_change"
        ? { tone: "idle", label: "No change", glyph: "○", live: false }
        : { tone: "ok", label: "Succeeded", glyph: "●", live: false };
    case "failed":
      return { tone: "bad", label: "Failed", glyph: "✕", live: false };
    case "rolled_back":
      return { tone: "warn", label: "Rolled back", glyph: "⟲", live: false };
    case "rollback_failed":
      return { tone: "bad", label: "Needs attention", glyph: "⚠", live: false };
    case "canceled":
      return { tone: "mute", label: "Canceled", glyph: "–", live: false };
    case "queued":
      return { tone: "idle", label: "Queued", glyph: "◌", live: false };
    case "interrupted":
      return { tone: "warn", label: "Interrupted", glyph: "?", live: false };
    default:
      return { tone: "run", label: ACTIVE_LABELS[state] ?? "Deploying", glyph: "◐", live: true };
  }
}

const DOT_TONE: Record<StatusTone, string> = {
  ok: "bg-ok",
  run: "bg-run",
  warn: "bg-warn",
  bad: "bg-bad",
  idle: "bg-idle",
  mute: "bg-mute",
};

const TEXT_TONE: Record<StatusTone, string> = {
  ok: "text-ok",
  run: "text-run",
  warn: "text-warn",
  bad: "text-bad",
  idle: "text-ink-2",
  mute: "text-ink-3",
};

export function StatusDot({ meta, className }: { meta: StatusMeta; className?: string }) {
  return (
    <span
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        DOT_TONE[meta.tone],
        meta.live && "animate-pulse-dot",
        className,
      )}
      aria-hidden
    />
  );
}

/** Dot plus word. The word is what makes the dot unambiguous. */
export function StatusBadge({
  state,
  outcome,
  className,
}: {
  state: DeploymentState;
  outcome?: DeploymentOutcome | undefined;
  className?: string | undefined;
}) {
  const meta = statusMeta(state, outcome);
  return (
    <span className={cn("inline-flex items-center gap-2 text-[13px] font-medium", className)}>
      <StatusDot meta={meta} />
      <span className={TEXT_TONE[meta.tone]}>{meta.label}</span>
    </span>
  );
}

/** The larger form, for a page header where the status is the headline. */
export function StatusHeadline({
  state,
  outcome,
  className,
}: {
  state: DeploymentState;
  outcome?: DeploymentOutcome | undefined;
  className?: string | undefined;
}) {
  const meta = statusMeta(state, outcome);
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <StatusDot meta={meta} className="size-2.5" />
      <span className={cn("text-[15px] font-semibold tracking-tight", TEXT_TONE[meta.tone])}>
        {meta.label}
      </span>
    </span>
  );
}
