/**
 * A project's human name and its machine slug.
 *
 * Two types because they have two jobs. The name is shown to people and may be
 * renamed freely. The slug is embedded in container names, image repositories, and
 * workspace paths, so it is constrained to what all of those accept and is treated
 * as stable — renaming a slug orphans everything already on the server under the
 * old one.
 */

import { type Brand, type Codec, brandedString } from "@/core/shared";

export type ProjectName = Brand<string, "ProjectName">;

export const ProjectName: Codec<ProjectName> = brandedString<ProjectName>({
  label: "Project name",
  code: "PROJECT_NAME_INVALID",
  minLength: 2,
  maxLength: 64,
  predicate: (value) => !/[\r\n\t\u0000]/.test(value),
  predicateHint: "not contain line breaks, tabs, or NUL bytes",
});

/**
 * A DNS-label-safe identifier.
 *
 * The 63-character ceiling and the no-leading-or-trailing-hyphen rule are DNS label
 * rules, which container names, image repository components, and hostnames all
 * inherit. Satisfying the strictest consumer once avoids a slug that is valid in
 * three places and rejected by the fourth. Consecutive hyphens are permitted, because
 * DNS permits them.
 */
export type ProjectSlug = Brand<string, "ProjectSlug">;

export const ProjectSlug: Codec<ProjectSlug> = brandedString<ProjectSlug>({
  label: "Project slug",
  code: "PROJECT_SLUG_INVALID",
  minLength: 2,
  maxLength: 63,
  lowercase: true,
  pattern: /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
  patternHint:
    "be lowercase alphanumeric with hyphens inside, not at either end, such as 'one-community'",
});
