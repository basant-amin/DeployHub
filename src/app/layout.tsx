import type { Metadata } from "next";
import type { ReactNode } from "react";

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
 * `data-theme="dark"` is set explicitly rather than following the OS. This is an instrument panel
 * and it should look the same on every machine in the team.
 */
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
