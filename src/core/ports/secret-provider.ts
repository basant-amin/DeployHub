/**
 * `SecretProvider` — turn a reference into a value, as late as possible.
 *
 * The domain carries `SecretRef` pointers and never a secret value, so that a project
 * or deployment record can be logged, serialized, and persisted without leaking
 * anything. This port is where that indirection is finally cashed in — at the moment of
 * use, in the adapter that needs it, and nowhere else.
 *
 * Two methods because a project has two kinds of secret, and they resolve to different
 * shapes: a git credential is one opaque value, a runtime environment is a set of named
 * variables. Collapsing them into one `resolve` returning a string would force every
 * caller to parse.
 *
 * `exists` is separate from resolving, and preflight uses only that. Checking presence
 * before a deployment starts is worth doing; pulling the value into memory minutes
 * before it is needed is not.
 *
 * Every resolved value must be handed to the `Redactor` that the log sink is opened
 * with. That is the contract this port depends on to stay safe.
 */

import type { Result, SecretRef } from "@/core/shared";

export interface SecretProvider {
  /**
   * Whether the secret exists, without reading it.
   *
   * Preflight's check that a deployment will not fail on a missing credential twenty
   * seconds into a build.
   */
  exists(ref: SecretRef): Promise<Result<boolean>>;

  /**
   * A single opaque credential — a token, a key, a password.
   *
   * The caller must register the returned value with the deployment's redactor before
   * anything is logged from the operation that uses it.
   */
  resolveCredential(ref: SecretRef): Promise<Result<string>>;

  /**
   * A set of environment variables for a container.
   *
   * Returned as a map rather than a string so no caller has to agree with any other
   * caller about how a `.env` file is parsed.
   */
  resolveEnvironment(ref: SecretRef): Promise<Result<ReadonlyMap<string, string>>>;
}
