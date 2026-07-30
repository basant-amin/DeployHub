"use client";

/**
 * The three nav links, and the only reason they are a Client Component: `aria-current`.
 *
 * A sighted reader can see which page they are on from the heading. A screen-reader user cannot, and
 * "Deployments, link" three times with no indication of which one is current is a navigation you have
 * to guess at. That is worth `usePathname`.
 *
 * Deliberately scoped to the links rather than the whole bar, so the wordmark, the sign-out form, and
 * the palette trigger stay server-rendered.
 */

import { usePathname } from "next/navigation";

import { Link } from "@/components/ui/link";
import { cn } from "@/lib/utils";

const LINKS: readonly { readonly href: string; readonly label: string }[] = [
  { href: "/", label: "Production" },
  { href: "/deployments", label: "Deployments" },
  { href: "/settings", label: "Settings" },
];

export function NavLinks() {
  const pathname = usePathname();

  return (
    <nav className="ml-2 flex items-center gap-1" aria-label="Main">
      {LINKS.map((link) => {
        const current = isCurrent(pathname, link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={current ? "page" : undefined}
            className={cn(
              "rounded-md px-2.5 py-1.5 text-[13px] transition-colors duration-100",
              current ? "bg-raised text-ink" : "text-ink-2 hover:bg-raised hover:text-ink",
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * A deployment detail page is still "Deployments".
 *
 * Exact matching would leave the whole detail screen — the most-visited page in the product — showing
 * no current section at all.
 */
function isCurrent(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
