/**
 * Workspace-relative paths.
 *
 * Every path the platform accepts from configuration is relative to a project's
 * workspace and must stay inside it. `..` segments, absolute paths, backslashes, and
 * NUL bytes are rejected here rather than in the adapter that eventually resolves
 * the path, because a traversal that reaches an adapter has already been trusted by
 * everything in between.
 */

import type { Brand } from "./brand";
import { type Codec, brandedString } from "./codec";

/** A backslash or a NUL byte. Neither belongs in any path the platform accepts. */
const FORBIDDEN_PATH_CHARACTERS = /[\\\u0000]/;

/**
 * A relative POSIX path with no traversal: `Dockerfile`, `apps/web/Dockerfile`, or
 * `.` for the workspace root.
 */
export type RelativePath = Brand<string, "RelativePath">;

function isSafeRelativePath(value: string): boolean {
  if (value.startsWith("/") || FORBIDDEN_PATH_CHARACTERS.test(value)) {
    return false;
  }
  if (value === ".") {
    return true;
  }
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export const RelativePath: Codec<RelativePath> = brandedString<RelativePath>({
  label: "Relative path",
  code: "RELATIVE_PATH_INVALID",
  maxLength: 512,
  predicate: isSafeRelativePath,
  predicateHint:
    "be a relative POSIX path inside the workspace: no leading '/', no '..' or '.' segments, no empty segments, and no backslashes",
});

/**
 * An absolute URL path used as a health check target: `/`, `/healthz`,
 * `/api/health?deep=1`.
 */
export type UrlPath = Brand<string, "UrlPath">;

function isSafeUrlPath(value: string): boolean {
  return value.startsWith("/") && !FORBIDDEN_PATH_CHARACTERS.test(value) && !value.includes("..");
}

export const UrlPath: Codec<UrlPath> = brandedString<UrlPath>({
  label: "URL path",
  code: "RELATIVE_PATH_INVALID",
  maxLength: 512,
  predicate: isSafeUrlPath,
  predicateHint: "start with '/' and contain no '..' segments, backslashes, or NUL bytes",
});
