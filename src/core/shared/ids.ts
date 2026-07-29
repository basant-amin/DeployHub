/**
 * Entity identifiers.
 *
 * Each is a distinct branded type, so passing a `DeploymentId` where a `ProjectId`
 * belongs is a compile error rather than a query that returns nothing.
 *
 * The domain validates ids but never *generates* them: generation is a side effect
 * and belongs behind the `IdGenerator` port. The accepted shape is deliberately
 * broad enough for ULID, UUID, and nanoid so that choice stays an infrastructure
 * concern.
 */

import type { Brand } from "./brand";
import { type Codec, brandedString } from "./codec";

const ID_SPEC = {
  minLength: 8,
  maxLength: 64,
  pattern: /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
  patternHint:
    "start with a letter or digit and contain only letters, digits, hyphens, and underscores",
} as const;

export type ProjectId = Brand<string, "ProjectId">;
export type DeploymentId = Brand<string, "DeploymentId">;
export type ReleaseId = Brand<string, "ReleaseId">;

export const ProjectId: Codec<ProjectId> = brandedString<ProjectId>({
  ...ID_SPEC,
  label: "Project id",
  code: "IDENTIFIER_INVALID",
});

export const DeploymentId: Codec<DeploymentId> = brandedString<DeploymentId>({
  ...ID_SPEC,
  label: "Deployment id",
  code: "IDENTIFIER_INVALID",
});

export const ReleaseId: Codec<ReleaseId> = brandedString<ReleaseId>({
  ...ID_SPEC,
  label: "Release id",
  code: "IDENTIFIER_INVALID",
});
