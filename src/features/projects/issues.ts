/**
 * Putting a domain validation issue next to the input that caused it.
 *
 * `combineFields` reports every bad field at once, as strings shaped like a path then the problem:
 * `slug: must be at least 2 characters`, `config.route.host: …`. Nested composites keep their path,
 * so a bad health-check status arrives as `config.healthCheck.expectedStatus: …`. That is already the
 * form's field name — the two agree because the form's names were chosen to be the domain's paths —
 * so attribution needs no mapping table to drift out of date.
 *
 * Matching is by longest known path, not by splitting on the first `": "`. Some messages contain a
 * colon of their own (`"FOO" is not a valid build arg name: use letters…`), and splitting would invent
 * a field called `config.buildArgs."FOO" is not a valid build arg name`. Anything that matches no path
 * is shown above the form rather than silently dropped: an error nobody sees is worse than an error in
 * the wrong place, and that bucket is how the two health-check aliases were discovered.
 */

export interface AttributedIssues {
  /** Field name → the messages for it, in the order the domain reported them. */
  readonly byField: Readonly<Record<string, readonly string[]>>;
  /** Issues that matched no path. Rendered at the top of the form. */
  readonly general: readonly string[];
}

/**
 * A path only matches at a boundary.
 *
 * `config.healthCheck.path` must not claim `config.healthCheck.pathological…`, so the character after
 * the match may not continue an identifier. Everything else is fair: the domain separates a path from
 * its message with `: ` for a field check, `.` for a nested one, and a bare space when a cross-field
 * rule opens with the field it is about (`totalBudgetMillis (30000) is shorter than…`).
 */
const CONTINUES_IDENTIFIER = /^[A-Za-z0-9_-]/;

export function attributeIssues(
  issues: readonly string[],
  paths: Readonly<Record<string, string>>,
): AttributedIssues {
  // Longest first, so `config.healthCheck.totalBudgetMillis` wins over `config.healthCheck.interval`.
  const candidates = Object.keys(paths).sort((a, b) => b.length - a.length);

  const byField: Record<string, string[]> = {};
  const general: string[] = [];

  for (const issue of issues) {
    const path = candidates.find(
      (candidate) =>
        issue === candidate ||
        (issue.startsWith(candidate) && !CONTINUES_IDENTIFIER.test(issue.slice(candidate.length))),
    );

    if (path === undefined) {
      general.push(issue);
      continue;
    }

    const field = paths[path] ?? path;
    const message = issue
      .slice(path.length)
      .replace(/^(: |\.)/, "")
      .trim();
    (byField[field] ??= []).push(message === "" ? issue : message);
  }

  return { byField, general };
}

/**
 * The first sentence of a message, capitalised, for the line under an input.
 *
 * Domain messages read as sentence fragments continuing their label — "must be at least 2
 * characters" — which is exactly right beside a label and wrong on its own.
 */
export function fieldMessage(label: string, message: string): string {
  const startsLowercase = /^[a-z]/.test(message);
  return startsLowercase ? `${label} ${message}` : message;
}
