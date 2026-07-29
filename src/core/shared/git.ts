/**
 * Git value objects.
 *
 * `GitRef` and `CommitSha` are deliberately different types. A ref is a *request*
 * — a branch name that may point somewhere else a second from now. A sha is an
 * *answer*. Once the ref has been resolved, everything downstream takes the sha,
 * so a push landing mid-deployment cannot change what gets built.
 */

import type { Brand } from "./brand";
import { type Codec, brandedString } from "./codec";

/**
 * A remote repository location: an `https://` URL, an `ssh://` URL, or the scp-like
 * form `git@host:owner/repo.git`.
 */
export type GitRepositoryUrl = Brand<string, "GitRepositoryUrl">;

const GIT_REPOSITORY_URL_PATTERN =
  /^(?:https:\/\/[^\s/@]+(?::\d+)?\/\S+|ssh:\/\/[^\s/@]+@[^\s/@]+(?::\d+)?\/\S+|[^\s/@]+@[^\s/@:]+:\S+)$/;

export const GitRepositoryUrl: Codec<GitRepositoryUrl> = brandedString<GitRepositoryUrl>({
  label: "Git repository URL",
  code: "GIT_REPOSITORY_URL_INVALID",
  maxLength: 512,
  pattern: GIT_REPOSITORY_URL_PATTERN,
  patternHint: "be an https:// URL, an ssh:// URL, or of the form git@host:owner/repo.git",
});

/**
 * A branch or tag name, validated against git's own ref rules.
 *
 * The rejected characters are not cosmetic: git's revision operators would make a
 * ref be *interpreted* rather than resolved. Also rejected: a leading `/`, empty
 * path segments, `..`, `@{`, a `.lock` suffix, a bare `@`, whitespace, control
 * characters, and a trailing `/` or `.`.
 */
export type GitRef = Brand<string, "GitRef">;

/** Git's revision operators: `~ ^ : ? * [` and the backslash. */
const GIT_REF_OPERATORS: ReadonlySet<string> = new Set(["~", "^", ":", "?", "*", "[", "\\"]);

function isValidGitRef(value: string): boolean {
  if (value === "@" || value.startsWith("/") || value.endsWith("/") || value.endsWith(".")) {
    return false;
  }
  if (value.includes("//") || value.includes("..") || value.includes("@{")) {
    return false;
  }
  if (value.endsWith(".lock")) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    // Whitespace and control characters (including DEL), plus revision operators.
    if (GIT_REF_OPERATORS.has(character) || codePoint <= 0x20 || codePoint === 0x7f) {
      return false;
    }
  }
  return true;
}

export const GitRef: Codec<GitRef> = brandedString<GitRef>({
  label: "Git ref",
  code: "GIT_REF_INVALID",
  maxLength: 255,
  predicate: isValidGitRef,
  predicateHint:
    "be a valid git ref: no whitespace, no '..', no '@{', no revision operators, and no leading or trailing '/' or '.'",
});

/**
 * A full 40-character SHA-1 commit hash, normalized to lowercase.
 *
 * Abbreviated shas are rejected. They are ambiguous by construction, and the point
 * of recording a sha is that it identifies exactly one commit forever.
 */
export type CommitSha = Brand<string, "CommitSha">;

export const CommitSha: Codec<CommitSha> = brandedString<CommitSha>({
  label: "Commit sha",
  code: "COMMIT_SHA_INVALID",
  minLength: 40,
  maxLength: 40,
  lowercase: true,
  pattern: /^[0-9a-f]{40}$/,
  patternHint: "be a full 40-character hexadecimal commit sha",
});
