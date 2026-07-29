import NextLink from "next/link";
import type { ComponentProps } from "react";

/**
 * `next/link`, with prefetching off.
 *
 * Every route in DeployHub is `force-dynamic` — a dashboard that caches its own pages is a dashboard
 * that lies — so a prefetch cannot produce a reusable payload. Left on, it is pure cost, and while a
 * deployment page is polling it is *multiplied* cost: each `router.refresh()` invalidates the client
 * router cache, which makes every visible link prefetch again. Measured on the deployment detail
 * screen, one refresh per second was fetching three routes per second — the page itself plus the two
 * top-bar links. With this it fetches one.
 *
 * Navigation is not measurably slower without it. These pages render in single-digit milliseconds
 * from a local SQLite file; prefetching exists to hide a network round trip to a database that is
 * somewhere else.
 *
 * This wrapper exists rather than `prefetch={false}` at eleven call sites so the reason is written
 * down once, and so the next link added inherits it. The ESLint config forbids importing `next/link`
 * anywhere else.
 */
export function Link({ prefetch = false, ...props }: ComponentProps<typeof NextLink>) {
  return <NextLink prefetch={prefetch} {...props} />;
}
