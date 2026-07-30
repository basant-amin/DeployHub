"use client";

/**
 * Copy, with the one piece of feedback that matters: whether it worked.
 *
 * The clipboard API fails in ways a user cannot predict — an insecure origin, a denied permission, a
 * browser that requires a user gesture it did not see. A button that silently does nothing in those
 * cases is how someone ends up pasting the previous thing on their clipboard into an incident channel.
 * So a failure says so, and offers the fallback: the text is selected, press the shortcut yourself.
 */

import { useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/primitives";

type State = "idle" | "copied" | "failed";

export function CopyButton({
  text,
  label,
  copiedLabel = "Copied",
  size = "sm",
  variant = "secondary",
}: {
  text: string;
  label: string;
  copiedLabel?: string;
  size?: "sm" | "md";
  variant?: "secondary" | "ghost";
}) {
  const [state, setState] = useState<State>("idle");
  const timer = useRef(0);

  const copy = async () => {
    window.clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    // Back to idle, so the button does not claim a stale success next time it is glanced at.
    timer.current = window.setTimeout(() => setState("idle"), 2_000);
  };

  return (
    <span className="inline-flex items-center gap-2">
      <Button type="button" variant={variant} size={size} onClick={() => void copy()}>
        {state === "copied" ? <Check className="text-ok" aria-hidden /> : <Copy aria-hidden />}
        {state === "copied" ? copiedLabel : label}
      </Button>
      {/* Announced, not just shown: the icon change is invisible to a screen reader. */}
      <span aria-live="polite" className="sr-only">
        {state === "copied" ? `${copiedLabel} to clipboard` : ""}
      </span>
      {state === "failed" && (
        <span className="text-bad text-[12px]" role="alert">
          Could not reach the clipboard — select the text and copy manually.
        </span>
      )}
    </span>
  );
}
