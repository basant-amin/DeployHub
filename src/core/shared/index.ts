/**
 * The shared kernel's public surface.
 *
 * Import from `@/core/shared` rather than reaching into individual files, so the
 * kernel's internal layout stays free to change.
 *
 * Value-object names are exported plainly rather than as types because each is
 * both: `CommitSha` is the type *and* the codec that produces it, merged under one
 * name so a call site reads `CommitSha.parse(...)` and returns a `CommitSha`.
 */

// -- Foundations ------------------------------------------------------------
export type { Brand } from "./brand";
export type { Codec } from "./codec";
export { brandedInteger, brandedString } from "./codec";

// -- Failure ----------------------------------------------------------------
export type { ErrorClass, ErrorCode } from "./error-codes";
export { ERROR_CATALOG, ERROR_CLASSES, errorClassOf } from "./error-codes";
export type { DeploymentErrorOptions, SerializedDeploymentError } from "./errors";
export { DeploymentError } from "./errors";

// -- Result -----------------------------------------------------------------
export type { Err, Ok, Result } from "./result";
export { err, ok, unwrapOrThrow } from "./result";

// -- Validation -------------------------------------------------------------
export type { IntegerSpec, StringSpec } from "./validation";
export { asRecord, checkCrossField, combineFields, parseInteger, parseString } from "./validation";

// -- Identity ---------------------------------------------------------------
export { DeploymentId, ProjectId, ReleaseId } from "./ids";
export { Actor, IdempotencyKey } from "./actor";

// -- Time -------------------------------------------------------------------
export { Duration, Timestamp } from "./time";

// -- Source -----------------------------------------------------------------
export { CommitSha, GitRef, GitRepositoryUrl, gitTransportOf } from "./git";
export type { GitTransport } from "./git";

// -- Runtime handles --------------------------------------------------------
export { ContainerId, ContainerName, ContainerPort } from "./container";
export { ImageDigest, ImageReference, ImageRepository, ImageTag } from "./image";

// -- Network ----------------------------------------------------------------
export { Hostname } from "./network";

// -- Paths and secrets ------------------------------------------------------
export { RelativePath, UrlPath } from "./path";
export { SecretRef } from "./secret-ref";

// -- Locking ----------------------------------------------------------------
export { LockEpoch } from "./lock-epoch";

// -- Redaction --------------------------------------------------------------
export type { RedactionRule } from "./redaction";
export { DEFAULT_REDACTION_RULES, REDACTED, Redactor, redact } from "./redaction";
