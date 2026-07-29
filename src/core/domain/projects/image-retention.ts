/**
 * `ImageRetention` — how many built images to keep per project.
 *
 * The floor is **two**, not one, and that is a domain rule rather than a
 * preference: the deployment flow requires the immediately previous image to remain
 * on the host so a rollback does not depend on a rebuild. A retention of one would
 * satisfy pruning while quietly destroying the recovery path the promotion step
 * relies on.
 */

import { type Brand, type Codec, brandedInteger } from "@/core/shared";

export type ImageRetention = Brand<number, "ImageRetention">;

/** Live image + previous image. Anything less breaks rollback. */
export const MINIMUM_IMAGE_RETENTION = 2;
const MAXIMUM_IMAGE_RETENTION = 50;

export const ImageRetention: Codec<ImageRetention> = brandedInteger<ImageRetention>({
  label: "Image retention",
  code: "IMAGE_RETENTION_INVALID",
  min: MINIMUM_IMAGE_RETENTION,
  max: MAXIMUM_IMAGE_RETENTION,
});
