/**
 * Who asked, and which request it was.
 *
 * `Actor` is an audit field, not an authorization one: the domain records who
 * triggered a deployment and never decides whether they were allowed to. Permission
 * is settled at the inbound boundary, before a use case is called.
 */

import type { Brand } from "./brand";
import { type Codec, brandedString } from "./codec";

/** An identifier for the human or system that triggered a deployment. */
export type Actor = Brand<string, "Actor">;

export const Actor: Codec<Actor> = brandedString<Actor>({
  label: "Actor",
  code: "ACTOR_INVALID",
  minLength: 2,
  maxLength: 128,
  predicate: (value) => !/[\r\n\u0000]/.test(value),
  predicateHint: "not contain line breaks or NUL bytes",
});

/**
 * A caller-supplied key that makes deployment requests idempotent.
 *
 * One key per intent, generated per click. Replaying a key returns the existing
 * deployment rather than starting a second one, which is what makes a
 * double-clicked Deploy button harmless instead of a race for the lock.
 */
export type IdempotencyKey = Brand<string, "IdempotencyKey">;

export const IdempotencyKey: Codec<IdempotencyKey> = brandedString<IdempotencyKey>({
  label: "Idempotency key",
  code: "IDEMPOTENCY_KEY_INVALID",
  minLength: 8,
  maxLength: 128,
  pattern: /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
  patternHint:
    "start with a letter or digit and contain only letters, digits, hyphens, and underscores",
});
