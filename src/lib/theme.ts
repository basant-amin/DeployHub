/**
 * Which theme the document renders in.
 *
 * Stored in a cookie rather than `localStorage`, and that is the whole design: the server reads it and
 * stamps `data-theme` into the HTML it sends, so the first paint is already correct. A theme read on
 * the client after hydration means every page load flashes the wrong one — a white flash on a dark
 * instrument panel, once per navigation, forever.
 *
 * Dark is the default and is *not* tied to the OS preference. This is an instrument panel and it
 * should look the same on every machine in the team; the toggle exists for the person who prefers
 * otherwise, not for their operating system to decide.
 */

export const THEME_COOKIE = "deployhub_theme";

export type Theme = "dark" | "light";

export function readTheme(value: string | undefined): Theme {
  return value === "light" ? "light" : "dark";
}

export function otherTheme(theme: Theme): Theme {
  return theme === "dark" ? "light" : "dark";
}
