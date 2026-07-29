import type { ReactNode } from "react";

import { TopBar } from "@/components/app-shell";

/**
 * The shell: one top bar, one centred column, nothing else.
 *
 * There is deliberately no sidebar. A sidebar is navigation for a hierarchy, and release 1 has one
 * project, one server, one environment — a permanent 240px column would advertise structure that
 * does not exist and train the layout to expect a tree we would then feel obliged to fill.
 */
export default function DashboardLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <>
      <TopBar />
      <main className="mx-auto w-full max-w-[1120px] px-6 pt-8 pb-24 sm:px-8">{children}</main>
    </>
  );
}
