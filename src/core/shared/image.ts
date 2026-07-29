/**
 * Container image value objects.
 *
 * `ImageReference` is a name that can be reassigned. `ImageDigest` is content —
 * `sha256:…` identifies exactly one image forever. The distinction is load-bearing:
 * a baseline records the digest, so "return to the previous image" cannot be
 * silently redirected by a tag that has since been moved.
 */

import type { Brand } from "./brand";
import { type Codec, brandedString } from "./codec";
import { DeploymentError } from "./errors";
import { type Result, err, ok } from "./result";
import { combineFields } from "./validation";

/** An immutable content address: `sha256:` followed by 64 lowercase hex digits. */
export type ImageDigest = Brand<string, "ImageDigest">;

export const ImageDigest: Codec<ImageDigest> = brandedString<ImageDigest>({
  label: "Image digest",
  code: "IMAGE_DIGEST_INVALID",
  minLength: 71,
  maxLength: 71,
  lowercase: true,
  pattern: /^sha256:[0-9a-f]{64}$/,
  patternHint: "be of the form sha256: followed by 64 hexadecimal characters",
});

/** The repository half of an image reference: `deployhub/one-community`. */
export type ImageRepository = Brand<string, "ImageRepository">;

export const ImageRepository: Codec<ImageRepository> = brandedString<ImageRepository>({
  label: "Image repository",
  code: "IMAGE_REFERENCE_INVALID",
  minLength: 2,
  maxLength: 255,
  lowercase: true,
  pattern: /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/,
  patternHint:
    "be a lowercase image repository name, optionally slash-separated, such as 'deployhub/one-community'",
});

/** The tag half of an image reference. */
export type ImageTag = Brand<string, "ImageTag">;

export const ImageTag: Codec<ImageTag> = brandedString<ImageTag>({
  label: "Image tag",
  code: "IMAGE_REFERENCE_INVALID",
  maxLength: 128,
  pattern: /^[A-Za-z0-9_][A-Za-z0-9._-]*$/,
  patternHint:
    "start with a letter, digit, or underscore and contain only letters, digits, periods, underscores, and hyphens",
});

/**
 * A `repository:tag` pair.
 *
 * Kept as two fields rather than one string because the two halves have different
 * rules and different lifetimes — the repository is stable per project, the tag
 * changes every deployment.
 */
export class ImageReference {
  private constructor(
    readonly repository: ImageRepository,
    readonly tag: ImageTag,
  ) {}

  /** Parse the canonical `repository:tag` form. A digest reference is not a tag. */
  static parse(raw: unknown): Result<ImageReference> {
    if (typeof raw !== "string") {
      return err(DeploymentError.of("IMAGE_REFERENCE_INVALID", "Image reference must be a string"));
    }
    const trimmed = raw.trim();
    const separator = trimmed.lastIndexOf(":");
    if (separator <= 0 || separator === trimmed.length - 1) {
      return err(
        DeploymentError.of(
          "IMAGE_REFERENCE_INVALID",
          `Image reference must be of the form repository:tag (received "${trimmed}")`,
        ),
      );
    }

    const fields = combineFields("IMAGE_REFERENCE_INVALID", "Invalid image reference", {
      repository: ImageRepository.parse(trimmed.slice(0, separator)),
      tag: ImageTag.parse(trimmed.slice(separator + 1)),
    });
    return fields.ok ? ok(new ImageReference(fields.value.repository, fields.value.tag)) : fields;
  }

  toString(): string {
    return `${this.repository}:${this.tag}`;
  }
}
