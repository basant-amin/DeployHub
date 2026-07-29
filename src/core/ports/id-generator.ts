/**
 * `IdGenerator` — mints the identifiers the domain refuses to invent.
 *
 * The domain validates ids but never generates them: generation is a side effect, and
 * an aggregate that assigns its own id cannot be reconstituted from storage with the
 * id it actually has. Keeping generation behind a port also keeps the *format* an
 * infrastructure choice — ULID, UUID, or nanoid all satisfy the domain's id rules.
 *
 * Synchronous, because every candidate format is generated locally from entropy and a
 * timestamp. An adapter that needed a round trip (a database sequence) would be the
 * wrong choice here for a second reason: it would put a network call on the admission
 * path.
 *
 * Note what this port does **not** do: allocate internal ports for candidate
 * containers. Only the host knows which ports are free, so that belongs to
 * `ContainerRuntime`, which returns the address it actually bound.
 */

import type { DeploymentId, ReleaseId } from "@/core/shared";

export interface IdGenerator {
  nextDeploymentId(): DeploymentId;
  nextReleaseId(): ReleaseId;
}
