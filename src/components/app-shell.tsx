/**
 * The top bar.
 *
 * Wordmark, three links, and the way out. Nothing more goes in permanent chrome. The project name is
 * absent on purpose — release 1 has one project, and its name is already the page heading; a second
 * project turns this into a picker, which is a change to this file and nothing else.
 */

import Link from "next/link";

import { signOut } from "@/app/actions";
import { cn } from "@/lib/utils";

export function TopBar() {
  return (
    <header className="border-line bg-canvas/85 sticky top-0 z-40 border-b backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-[1120px] items-center gap-4 px-6 sm:px-8">
        <Link
          href="/"
          className="text-ink flex items-center gap-2.5 text-[13px] font-semibold tracking-tight transition-opacity duration-100 hover:opacity-80"
        >
          <Diamond />
          DeployHub
        </Link>

        <nav className="ml-2 flex items-center gap-1" aria-label="Main">
          <TopBarLink href="/">Production</TopBarLink>
          <TopBarLink href="/deployments">Deployments</TopBarLink>
          <TopBarLink href="/settings">Settings</TopBarLink>
        </nav>

        <div className="ml-auto flex items-center gap-4">
          <span className="text-ink-3 hidden text-[13px] sm:inline">Self-hosted</span>
          {/* A plain form, so signing out needs no client JavaScript and cannot be prefetched. */}
          <form action={signOut}>
            <button
              type="submit"
              className="text-ink-3 hover:text-ink rounded-md px-1 text-[13px] transition-colors duration-100"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}

/**
 * Not `usePathname` — that would make the whole bar a Client Component to render three links.
 * The active state is carried by `aria-current` from the page instead, in a later increment if it
 * proves worth the cost; three links do not get lost.
 */
function TopBarLink({ href, children }: { href: string; children: string }) {
  return (
    <Link
      href={href}
      className={cn(
        "text-ink-2 rounded-md px-2.5 py-1.5 text-[13px] transition-colors duration-100",
        "hover:bg-raised hover:text-ink",
      )}
    >
      {children}
    </Link>
  );
}

function Diamond() {
  return (
    <span
      aria-hidden
      className="border-accent bg-accent/25 inline-block size-3.5 rotate-45 rounded-[3px] border"
    />
  );
}
