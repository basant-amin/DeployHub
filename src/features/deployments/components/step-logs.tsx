/**
 * Logs, grouped by step.
 *
 * A four-thousand-line undifferentiated scrollback is a fallback, not a default. Lines are grouped
 * by the step that produced them and collapsed, with **exactly one** group open: the running step
 * while a deployment is in flight, the failed step when it failed, and the longest step when it
 * succeeded — because that is the one someone is most likely to be curious about.
 *
 * Built on native `<details>`. It is keyboard accessible, announced correctly by screen readers,
 * survives a re-render without state, and needs no client JavaScript at all — which matters here
 * because this component re-renders on every poll while a deployment runs. A React-state accordion
 * would either lose the reader's expansion on each poll or need synchronisation to avoid it.
 */

import { ChevronRight } from "lucide-react";

import type { LogLineView } from "@/core/application";
import type { STEP_NAMES } from "@/core/domain";
import { formatClock } from "@/lib/format";
import { cn } from "@/lib/utils";

import { LogFollow } from "./log-follow";

type StepName = (typeof STEP_NAMES)[number];

export function StepLogs({
  logs,
  /** Which group opens. Chosen by the page from the derived phases. */
  openStep,
}: {
  logs: readonly LogLineView[];
  openStep?: StepName | undefined;
}) {
  const byStep = groupByStep(logs);
  const names = [...byStep.keys()];
  const open = openStep !== undefined && byStep.has(openStep) ? openStep : names.at(-1);

  if (names.length === 0) {
    return (
      <p className="text-ink-3 px-4 py-6 text-[13px]">
        No log output yet. Lines appear here as each step runs.
      </p>
    );
  }

  return (
    <div className="divide-line divide-y">
      {names.map((name) => (
        <StepLogGroup key={name} name={name} lines={byStep.get(name) ?? []} open={name === open} />
      ))}
    </div>
  );
}

function StepLogGroup({
  name,
  lines,
  open,
}: {
  name: StepName;
  lines: readonly LogLineView[];
  open: boolean;
}) {
  // A group is "failed" when it contains stderr output: the engine writes the container's own
  // output to stderr precisely when a candidate did not become healthy.
  const failed = lines.some((line) => line.stream === "stderr");

  return (
    <details open={open} className="group">
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center gap-2.5 px-4 py-2.5 transition-colors duration-100",
          "hover:bg-raised focus-visible:bg-raised",
          failed && "bg-bad-bg",
        )}
      >
        <ChevronRight
          className="text-ink-3 size-3.5 shrink-0 transition-transform duration-150 group-open:rotate-90"
          aria-hidden
        />
        <span className={cn("flex-1 text-[13px] font-medium", failed ? "text-bad" : "text-ink")}>
          {name.replaceAll("_", " ")}
        </span>
        <span className="text-ink-3 text-[12px]">
          {lines.length} {lines.length === 1 ? "line" : "lines"}
        </span>
      </summary>

      {/* Only the open group follows its output. A collapsed group that silently scrolled itself to
          the bottom would land a reader at the end of a step they had just chosen to open. */}
      <LogFollow
        follow={open}
        lineCount={lines.length}
        className="scroll-quiet border-line bg-canvas max-h-[420px] overflow-auto border-t"
      >
        {lines.length === 0 ? (
          <p className="text-ink-3 px-4 py-3 text-[12.5px]">No output.</p>
        ) : (
          <ol className="py-1.5">
            {lines.map((line, index) => (
              <LogRow key={`${line.at}-${index}`} line={line} />
            ))}
          </ol>
        )}
      </LogFollow>
    </details>
  );
}

/**
 * One line. Never wraps — a wrapped log line destroys the column alignment that makes a log
 * scannable, so long lines scroll horizontally inside their own container instead.
 */
function LogRow({ line }: { line: LogLineView }) {
  return (
    <li className="flex gap-3 px-4 font-mono text-[12.5px] leading-[1.55] whitespace-pre">
      <span className="text-ink-3 shrink-0 select-none" data-numeric>
        {formatClock(line.at)}
      </span>
      <span
        className={cn(
          line.stream === "stderr" && "text-bad",
          line.stream === "system" && "text-ink-2",
          line.stream === "stdout" && "text-ink",
        )}
      >
        {line.text}
      </span>
    </li>
  );
}

/* -- Grouping ------------------------------------------------------------ */

function groupByStep(logs: readonly LogLineView[]): Map<StepName, LogLineView[]> {
  const grouped = new Map<StepName, LogLineView[]>();
  for (const line of logs) {
    const existing = grouped.get(line.step);
    if (existing === undefined) {
      grouped.set(line.step, [line]);
    } else {
      existing.push(line);
    }
  }
  return grouped;
}
