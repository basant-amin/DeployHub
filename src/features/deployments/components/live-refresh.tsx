"use client";

/**
 * The thing that makes a deployment page feel alive.
 *
 * It renders nothing. Its whole job is to call `router.refresh()` on a schedule, which re-runs the
 * server render and streams the new HTML into the existing tree. That is why every screen in this
 * feature stayed a Server Component: there is no second copy of the deployment on the client, no
 * fetch layer, no cache to invalidate, and no possibility of the polled data and the rendered data
 * disagreeing. The `<details>` groups keep their DOM state across a refresh; React patches the text.
 *
 * Four rules, each of them a way of not wasting the reader's battery:
 *
 * 1. Stop entirely once the deployment reaches a state that cannot change (`isLive`).
 * 2. Skip the request while the tab is hidden — nobody is reading it.
 * 3. Refresh immediately when the tab comes back, so returning to it never shows stale state.
 * 4. Back off from one second to three once nothing has changed for two minutes.
 */

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import { pollDelay } from "../live";

/** Two wake-ups can land together — a focus event and a scheduled tick. One refresh is enough. */
const COALESCE_MILLIS = 250;

export function LiveRefresh({
  live,
  /**
   * Any string that changes when the server has something new to show. The back-off clock restarts
   * whenever it does, so "nothing has changed for two minutes" means exactly that.
   */
  signature,
}: {
  live: boolean;
  signature: string;
}) {
  const router = useRouter();
  // Both are stamped inside effects, never during render — a clock read while rendering is exactly
  // the kind of unstable value React's purity rule exists to catch.
  const lastChangeAt = useRef(0);
  const lastRefreshAt = useRef(0);

  // Declared before the polling effect, so on mount it has stamped the clock before the first tick.
  useEffect(() => {
    lastChangeAt.current = Date.now();
  }, [signature]);

  // Deliberately not keyed on `signature`: that would tear down and rebuild the timer on every
  // poll. The interval is read from the ref at each tick instead, so the back-off still responds.
  useEffect(() => {
    if (!live) {
      return;
    }

    let timer = 0;

    const refresh = () => {
      const now = Date.now();
      if (now - lastRefreshAt.current < COALESCE_MILLIS) {
        return;
      }
      lastRefreshAt.current = now;
      router.refresh();
    };

    const tick = () => {
      // Skipping the request rather than the timer means the loop resumes by itself when the tab
      // comes back, with no state to get out of step.
      if (document.visibilityState === "visible") {
        refresh();
      }
      timer = window.setTimeout(tick, pollDelay(Date.now() - lastChangeAt.current));
    };

    const onWake = () => {
      if (document.visibilityState === "visible") {
        refresh();
      }
    };

    timer = window.setTimeout(tick, pollDelay(0));
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, [live, router]);

  return null;
}
