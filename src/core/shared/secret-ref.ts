/**
 * `SecretRef` — a *pointer* to a credential, never the credential.
 *
 * The domain reasons about which secret a project needs; it never holds the value.
 * Resolution happens behind the `SecretProvider` port at the moment of use, so a
 * secret cannot be persisted on a project record, serialized into a deployment
 * snapshot, or logged by an aggregate that stringifies itself.
 */

import type { Brand } from "./brand";
import { type Codec, brandedString } from "./codec";

export type SecretRef = Brand<string, "SecretRef">;

export const SecretRef: Codec<SecretRef> = brandedString<SecretRef>({
  label: "Secret reference",
  code: "SECRET_REF_INVALID",
  minLength: 3,
  maxLength: 128,
  pattern: /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/,
  patternHint:
    "be a lowercase dotted key such as 'one-community.git.credentials' — letters, digits, dots, hyphens, and underscores only",
});
