/**
 * The gate.
 *
 * Everything except the sign-in page and Next's own assets requires a valid session. The check lives
 * here rather than in each page so there is one place to reason about, and so adding a page cannot
 * accidentally add an unauthenticated route.
 *
 * It is not the only check. Every mutating server action re-verifies the session itself, because a
 * server action is a separately addressable endpoint and this file only sees navigations.
 *
 * With no password configured, every route redirects to sign-in, which explains what to set. A tool
 * whose main verb is "change what production is running" does not get an open-by-default mode.
 *
 * (Named `proxy` rather than `middleware`: Next 16 renamed the convention.)
 */

import { type NextRequest, NextResponse } from "next/server";

import { SESSION_COOKIE, expectedToken, isConfigured, tokensMatch } from "@/lib/session";

export const config = {
  // Everything but Next's own assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === "/signin") {
    return NextResponse.next();
  }

  const password = process.env.DEPLOYHUB_PASSWORD;
  if (!isConfigured(password)) {
    return NextResponse.redirect(new URL("/signin?reason=unconfigured", request.url));
  }

  const presented = request.cookies.get(SESSION_COOKIE)?.value;
  if (tokensMatch(presented, await expectedToken(password))) {
    return NextResponse.next();
  }

  // Remember where they were going, so signing in lands them there rather than at the home page.
  const signin = new URL("/signin", request.url);
  if (pathname !== "/") {
    signin.searchParams.set("next", pathname);
  }
  return NextResponse.redirect(signin);
}
