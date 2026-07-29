"use client";

/**
 * The scroll pane for one step's log lines.
 *
 * A client component wrapping server-rendered children, which is the smallest possible island for
 * this: the lines themselves stay on the server, and the only thing that needs a browser is knowing
 * where the reader is looking.
 *
 * It follows new output — but only while the reader is at the bottom. Scroll up to read something
 * and it stops fighting you; scroll back down and it resumes. A log pane that yanks you to the
 * bottom mid-sentence is worse than one that never scrolls at all.
 */

import { type ReactNode, useEffect, useRef } from "react";

/** How close to the bottom still counts as "at the bottom". One line's worth, roughly. */
const PINNED_WITHIN_PIXELS = 24;

export function LogFollow({
  follow,
  /** Changes when there is new output. The only reason to re-scroll. */
  lineCount,
  className,
  children,
}: {
  follow: boolean;
  lineCount: number;
  className?: string;
  children: ReactNode;
}) {
  const pane = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const element = pane.current;
    if (element === null || !follow || !pinned.current) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  }, [follow, lineCount]);

  return (
    <div
      ref={pane}
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < PINNED_WITHIN_PIXELS;
      }}
      className={className}
    >
      {children}
    </div>
  );
}
