"use client";

/**
 * The whole log, in one scrollback.
 *
 * The grouped view is right almost always — it puts you on the step that matters and hides the rest.
 * Almost always is not always: sometimes the thing you need is the boundary *between* two steps, or a
 * line whose step you cannot guess, and then a single continuous log is the only view that helps.
 *
 * So it exists, as a sheet rather than a screen, and it is not the default. A four-thousand-line
 * undifferentiated scrollback is a fallback; making it the front door is what every other tool does.
 *
 * Right-hand sheet rather than a centred dialog: a log is tall and narrow, and reading one while the
 * page it belongs to is still visible beside it is the whole reason to open it here instead of
 * downloading a file.
 */

import { useRef } from "react";
import { X } from "lucide-react";

import type { LogLineView } from "@/core/application";
import { Button } from "@/components/ui/primitives";
import { formatClock } from "@/lib/format";
import { cn } from "@/lib/utils";

import { CopyButton } from "./copy-button";

export function RawLogSheet({ lines, text }: { lines: readonly LogLineView[]; text: string }) {
  const dialog = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button
        type="button"
        onClick={() => dialog.current?.showModal()}
        className="text-ink-3 hover:text-ink text-[12px] transition-colors duration-100"
      >
        Raw log
      </button>

      <dialog
        ref={dialog}
        aria-labelledby="raw-log-title"
        className={cn(
          // Pinned right and full height. Tailwind's preflight zeroes the margin the UA uses to
          // centre a modal, which is exactly what this needs.
          "border-line bg-surface text-ink shadow-modal m-0 ml-auto h-dvh max-h-dvh w-[min(52rem,100vw)] rounded-none border-l p-0",
          "backdrop:bg-black/60",
        )}
      >
        <div className="flex h-full flex-col">
          <header className="border-line flex shrink-0 items-center gap-3 border-b px-4 py-3">
            <h2 id="raw-log-title" className="text-ink flex-1 text-[13px] font-medium">
              Raw log
              <span className="text-ink-3 ml-2 font-normal">
                {lines.length} {lines.length === 1 ? "line" : "lines"}
              </span>
            </h2>
            <CopyButton text={text} label="Copy log" />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => dialog.current?.close()}
              aria-label="Close raw log"
            >
              <X aria-hidden />
            </Button>
          </header>

          <div className="scroll-quiet bg-canvas flex-1 overflow-auto">
            {lines.length === 0 ? (
              <p className="text-ink-3 px-4 py-6 text-[13px]">No log output.</p>
            ) : (
              <ol className="py-2">
                {lines.map((line, index) => (
                  <li
                    key={`${line.at}-${index}`}
                    className="flex gap-3 px-4 font-mono text-[12.5px] leading-[1.55] whitespace-pre"
                  >
                    <span className="text-ink-3 shrink-0 select-none" data-numeric>
                      {formatClock(line.at)}
                    </span>
                    {/* The step, which the grouped view carries in its heading instead. */}
                    <span className="text-ink-3 w-32 shrink-0 select-none">{line.step}</span>
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
                ))}
              </ol>
            )}
          </div>
        </div>
      </dialog>
    </>
  );
}
