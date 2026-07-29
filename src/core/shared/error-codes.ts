/**
 * The error taxonomy: every failure class, and every code the domain layer uses.
 *
 * Codes are a **public contract**. They are persisted on deployment records, shown
 * in the UI, and matched by notification rules, so a code is renamed the way a
 * database column is renamed — deliberately, with a migration. The human-readable
 * message may change freely; the code may not.
 *
 * Each code declares its class exactly once, in `ERROR_CATALOG`. The class
 * determines how the platform responds to a failure, and deriving it from the code
 * removes the possibility of the same code being raised as two different classes
 * from two different call sites.
 *
 * **Adding a code:** add it in the same change as the code that raises it. The
 * catalog deliberately contains no entry without a producer — a code nobody raises
 * is an untested guess about its own classification, and it will be wrong about as
 * often as it is right. Adapter-specific codes (SSH, Docker, git, proxy, preflight)
 * therefore arrive with their adapters, not ahead of them.
 *
 * Note what is absent by design: retry eligibility. A class does not know whether to
 * retry — that is a policy decision made against both the class and the step, and
 * encoding it here would scatter the platform's retry behavior across two layers.
 */

/**
 * Failure classes, per `docs/architecture/deployment-engine.md`.
 *
 * The full taxonomy is listed even where the domain layer raises nothing of that
 * class yet, because the classes are the architecture's contract and outer layers
 * classify against them.
 *
 * - `VALIDATION` — malformed input. Never retried; the caller must change it.
 * - `PRECONDITION` — the request is well-formed but the world is not ready.
 * - `TRANSIENT` — an infrastructure hiccup that may resolve on its own.
 * - `USER_CODE` — the deployed application failed. Deterministic, never retried.
 * - `INFRA` — the platform's own infrastructure failed.
 * - `TIMEOUT` — a step or the deployment exceeded its budget.
 * - `CANCELED` — an operator stopped it.
 * - `INTERNAL` — a DeployHub bug or violated invariant. Always alerts.
 */
export const ERROR_CLASSES = [
  "VALIDATION",
  "PRECONDITION",
  "TRANSIENT",
  "USER_CODE",
  "INFRA",
  "TIMEOUT",
  "CANCELED",
  "INTERNAL",
] as const;

export type ErrorClass = (typeof ERROR_CLASSES)[number];

/** Code → class. The single source of truth for both sets. */
export const ERROR_CATALOG = {
  // ---------------------------------------------------------------- VALIDATION
  // Value objects and aggregates rejecting malformed input.
  IDENTIFIER_INVALID: "VALIDATION",
  TIMESTAMP_INVALID: "VALIDATION",
  DURATION_INVALID: "VALIDATION",
  ACTOR_INVALID: "VALIDATION",
  IDEMPOTENCY_KEY_INVALID: "VALIDATION",
  LOCK_EPOCH_INVALID: "VALIDATION",
  SECRET_REF_INVALID: "VALIDATION",
  RELATIVE_PATH_INVALID: "VALIDATION",
  GIT_REPOSITORY_URL_INVALID: "VALIDATION",
  GIT_REF_INVALID: "VALIDATION",
  COMMIT_SHA_INVALID: "VALIDATION",
  IMAGE_REFERENCE_INVALID: "VALIDATION",
  IMAGE_DIGEST_INVALID: "VALIDATION",
  CONTAINER_ID_INVALID: "VALIDATION",
  CONTAINER_NAME_INVALID: "VALIDATION",
  CONTAINER_PORT_INVALID: "VALIDATION",
  PROJECT_NAME_INVALID: "VALIDATION",
  PROJECT_SLUG_INVALID: "VALIDATION",
  PUBLIC_ROUTE_INVALID: "VALIDATION",
  BUILD_ARGS_INVALID: "VALIDATION",
  IMAGE_RETENTION_INVALID: "VALIDATION",
  HEALTH_CHECK_SPEC_INVALID: "VALIDATION",
  DEPLOY_CONFIG_INVALID: "VALIDATION",
  PROJECT_INVALID: "VALIDATION",
  PROXY_UPSTREAM_INVALID: "VALIDATION",
  BASELINE_INVALID: "VALIDATION",
  CANDIDATE_INVALID: "VALIDATION",
  STEP_RECORD_INVALID: "VALIDATION",
  RELEASE_INVALID: "VALIDATION",
  DEPLOYMENT_INVALID: "VALIDATION",

  // -------------------------------------------------------------- PRECONDITION
  PROJECT_DISABLED: "PRECONDITION",
  DEPLOYMENT_IN_PROGRESS: "PRECONDITION",
  /** Another worker holds the project's deploy lease. */
  LOCK_BUSY: "PRECONDITION",
  // Asked for by id, absent from the store. A precondition rather than a validation
  // failure: the request was well-formed, the world does not contain the thing.
  PROJECT_NOT_FOUND: "PRECONDITION",
  DEPLOYMENT_NOT_FOUND: "PRECONDITION",
  RELEASE_NOT_FOUND: "PRECONDITION",
  ROLLBACK_NOT_ELIGIBLE: "PRECONDITION",
  // Preflight, which runs before any lock is taken and before the server is touched.
  PREFLIGHT_CREDENTIAL_MISSING: "PRECONDITION",
  /** The secret store itself is missing or unreadable. */
  SECRET_STORE_UNAVAILABLE: "PRECONDITION",
  GIT_AUTH_FAILED: "PRECONDITION",
  GIT_REF_NOT_FOUND: "PRECONDITION",
  PREFLIGHT_DISK_SPACE_LOW: "PRECONDITION",
  // The deployment reached a step without the state that step requires.
  BASELINE_REQUIRED: "PRECONDITION",
  SOURCE_NOT_RESOLVED: "PRECONDITION",
  IMAGE_NOT_BUILT: "PRECONDITION",
  CANDIDATE_NOT_STARTED: "PRECONDITION",
  HEALTH_CHECK_NOT_PASSED: "PRECONDITION",
  ROUTE_NOT_VERIFIED: "PRECONDITION",

  // ----------------------------------------------------------------- USER_CODE
  // The deployed application is at fault. Deterministic for a given commit.
  // These are raised by the engine and *stored* by the aggregate, one per
  // pre-promotion decision point in `docs/architecture/deployment-flow.md`.
  BUILD_FAILED: "USER_CODE",
  /** The source could not be fetched — network, or a bad repository URL. */
  GIT_FETCH_FAILED: "TRANSIENT",
  CONTAINER_START_FAILED: "USER_CODE",
  /** Started, then died on its own — a crash on boot rather than a refusal to start. */
  CONTAINER_EXITED: "USER_CODE",
  HEALTH_CHECK_FAILED: "USER_CODE",

  // --------------------------------------------------------------------- INFRA
  /** A process could not be started, or exited non-zero where that means broken. */
  COMMAND_FAILED: "INFRA",
  /** The container runtime did not answer. */
  DOCKER_UNAVAILABLE: "INFRA",
  /** The reverse proxy's admin interface did not answer. */
  PROXY_UNAVAILABLE: "INFRA",
  /** The store could not be read or written. */
  STORAGE_FAILED: "INFRA",
  ROUTE_VERIFICATION_FAILED: "INFRA",
  ROLLBACK_FAILED: "INFRA",
  /** The proxy would not accept or reload the new routing. */
  PROXY_RELOAD_FAILED: "INFRA",
  DISK_FULL: "INFRA",

  // ------------------------------------------------------------------- TIMEOUT
  STEP_TIMEOUT: "TIMEOUT",

  // ------------------------------------------------------------------ CANCELED
  DEPLOYMENT_CANCELED: "CANCELED",

  // ------------------------------------------------------------------ INTERNAL
  // A DeployHub bug. Reaching one of these means an invariant did not hold.
  ILLEGAL_STATE_TRANSITION: "INTERNAL",
  OPERATION_NOT_VALID_IN_STATE: "INTERNAL",
  NON_MONOTONIC_TIMESTAMP: "INTERNAL",
  INVARIANT_VIOLATION: "INTERNAL",
} as const satisfies Record<string, ErrorClass>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

/** The class a code belongs to. Total by construction — no default branch. */
export function errorClassOf<C extends ErrorCode>(code: C): (typeof ERROR_CATALOG)[C] {
  return ERROR_CATALOG[code];
}
