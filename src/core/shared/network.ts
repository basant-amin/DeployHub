/**
 * Network address primitives.
 *
 * `Hostname` lives in the shared kernel rather than in either context that uses it,
 * because both do: a project's public route names the host users reach, and a proxy
 * upstream names the host a container is reached at. The rules are identical, and
 * defining them twice would let them drift.
 */

import type { Brand } from "./brand";
import { type Codec, brandedString } from "./codec";

/**
 * A DNS hostname or dotted-quad address. Single labels (`localhost`) and loopback
 * addresses (`127.0.0.1`) are both valid — on a single-server deployment the
 * upstream is nearly always one of them.
 */
export type Hostname = Brand<string, "Hostname">;

export const Hostname: Codec<Hostname> = brandedString<Hostname>({
  label: "Hostname",
  code: "PUBLIC_ROUTE_INVALID",
  minLength: 1,
  maxLength: 253,
  lowercase: true,
  pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/,
  patternHint:
    "be a valid hostname: alphanumeric labels separated by dots, with hyphens allowed inside a label",
});
