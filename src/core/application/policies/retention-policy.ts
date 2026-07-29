/**
 * Image retention — which images the platform may remove.
 *
 * A pure function returning the set to delete, never performing the deletion. The
 * container runtime removes exactly the set it is given, because a runtime that decided
 * for itself would eventually prune the image a rollback needed.
 *
 * The rule is stated in terms of releases rather than of what happens to be on the host:
 * a release is something that shipped and might be rolled back to, and that is the only
 * reason to keep an image. Anything on the host outside the kept set is either the
 * current candidate, which the engine owns and never asks to prune, or debris.
 */

import type { ImageDigest } from "@/core/shared";
import type { ImageRetention } from "@/core/domain";
import type { Release } from "@/core/domain";

export interface RetentionInput {
  /** How many releases' images to keep. The domain's floor is two. */
  readonly retention: ImageRetention;
  /** The project's releases, newest first. */
  readonly releases: readonly Release[];
  /**
   * Digests that must survive regardless of age — the baseline of the deployment that
   * just ran, which may be older than the retention window on a rollback.
   */
  readonly protectedDigests: readonly ImageDigest[];
}

/**
 * Digests safe to remove: everything outside the newest `retention` releases, minus
 * anything explicitly protected.
 *
 * De-duplicated, because two releases of the same commit share a digest and asking the
 * runtime to remove one twice is noise in the log.
 */
export function imagesToRemove(input: RetentionInput): readonly ImageDigest[] {
  const keep = new Set<ImageDigest>(input.protectedDigests);
  for (const release of input.releases.slice(0, input.retention)) {
    keep.add(release.imageDigest);
  }

  const remove = new Set<ImageDigest>();
  for (const release of input.releases.slice(input.retention)) {
    if (!keep.has(release.imageDigest)) {
      remove.add(release.imageDigest);
    }
  }

  return Object.freeze([...remove]);
}
