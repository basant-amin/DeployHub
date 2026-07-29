"use client";

/**
 * A timestamp that reads as "2h ago" and carries the exact instant in its tooltip.
 *
 * The server passes both the epoch and the label it computed, and the first client render uses
 * that same label — so there is no hydration mismatch to suppress. Only after mount does the
 * label start refreshing, once a minute, which is the resolution the format actually has.
 */

import { useEffect, useState } from "react";

import { formatAbsolute, formatRelative } from "@/lib/format";

export function RelativeTime({
  epochMillis,
  initial,
  className,
}: {
  epochMillis: number;
  /** Computed on the server, so both renders agree. */
  initial: string;
  className?: string;
}) {
  const [label, setLabel] = useState(initial);

  useEffect(() => {
    const tick = () => setLabel(formatRelative(epochMillis));
    tick();
    const timer = setInterval(tick, 60_000);
    return () => clearInterval(timer);
  }, [epochMillis]);

  return (
    <time
      dateTime={new Date(epochMillis).toISOString()}
      title={formatAbsolute(epochMillis)}
      className={className}
    >
      {label}
    </time>
  );
}
