/**
 * The top bar.
 *
 * Wordmark, three links, the palette trigger, and the way out. Nothing more goes in permanent chrome.
 * The project name is absent on purpose — release 1 has one project, and its name is already the page
 * heading; a second project turns this into a picker, which is a change to this file and nothing else.
 */

import { signOut } from "@/app/actions";
import { CommandPalette } from "@/components/command-palette";
import { NavLinks } from "@/components/nav-links";
import { Link } from "@/components/ui/link";
import type { Theme } from "@/lib/theme";

export function TopBar({
  theme,
  /** The ref a palette-triggered deploy would use. Absent when a deploy would be refused. */
  deployRef,
}: {
  theme: Theme;
  deployRef: string | undefined;
}) {
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

        <NavLinks />

        <div className="ml-auto flex items-center gap-3">
          <CommandPalette theme={theme} deployRef={deployRef} />
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

function Diamond() {
  return (
    <span
      aria-hidden
      className="border-accent bg-accent/25 inline-block size-3.5 rotate-45 rounded-[3px] border"
    />
  );
}
