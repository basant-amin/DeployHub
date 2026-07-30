import { cookies } from "next/headers";
import type { ReactNode } from "react";

import { TopBar } from "@/components/app-shell";
import { loadProduction } from "@/features/deployments/data";
import { THEME_COOKIE, readTheme } from "@/lib/theme";

/**
 * The shell: one top bar, one centred column, nothing else.
 *
 * There is deliberately no sidebar. A sidebar is navigation for a hierarchy, and release 1 has one
 * project, one server, one environment — a permanent 240px column would advertise structure that does
 * not exist and train the layout to expect a tree we would then feel obliged to fill.
 *
 * It reads the project so the command palette knows whether a deploy is currently possible, and which
 * ref it would use. That is one indexed query against a local SQLite file — under a millisecond — and
 * it is what lets ⌘K offer the product's primary verb from any screen instead of only from the hero.
 */
export default async function DashboardLayout({ children }: Readonly<{ children: ReactNode }>) {
  const [store, production] = await Promise.all([cookies(), loadProduction(1)]);

  // Offered only when the domain would accept it: not paused, and nothing already in flight.
  const deployRef =
    production.kind === "ready" &&
    production.history.project.enabled &&
    production.history.project.activeDeploymentId === undefined
      ? production.history.project.targetRef
      : undefined;

  return (
    <>
      <TopBar theme={readTheme(store.get(THEME_COOKIE)?.value)} deployRef={deployRef} />
      <main id="main" className="mx-auto w-full max-w-[1120px] px-6 pt-8 pb-24 sm:px-8">
        {children}
      </main>
    </>
  );
}
