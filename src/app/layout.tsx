import type { Metadata } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";

import { THEME_COOKIE, readTheme } from "@/lib/theme";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "DeployHub",
    template: "%s · DeployHub",
  },
  description: "Self-hosted deployment platform for Docker applications.",
  applicationName: "DeployHub",
};

/**
 * The document, and nothing else.
 *
 * The chrome lives one level down in `(dashboard)/layout.tsx`, because the sign-in page must not
 * render navigation to pages it cannot reach — an empty top bar above a password field is an
 * invitation to click something that will only bounce you back here.
 *
 * `data-theme` comes from a cookie and is written into the HTML on the server, so the first paint is
 * already the right theme. Reading it on the client instead would flash the wrong one on every load.
 */
export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const theme = readTheme((await cookies()).get(THEME_COOKIE)?.value);

  return (
    <html lang="en" data-theme={theme} suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        {/*
          The first thing in the tab order, visible only when focused. Without it, reaching the
          Deploy button by keyboard means tabbing past the whole top bar on every page.
        */}
        <a
          href="#main"
          className="bg-accent text-accent-ink sr-only rounded-md px-3 py-2 text-[13px] font-medium focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
