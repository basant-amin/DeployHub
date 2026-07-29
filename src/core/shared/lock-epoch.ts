/**
 * `LockEpoch` — the fencing token issued with a deployment lock lease.
 *
 * Monotonically increasing: every takeover of an expired lease increments it. A
 * worker that stalled past its lease and resumes still carries the old epoch, so
 * the mutating call it issues is rejected instead of acting on a server that now
 * belongs to someone else.
 *
 * The domain only *carries* epochs. Issuing them, comparing them against a live
 * lease, and enforcing them against a server belong to the `DeployLock` port and its
 * adapter.
 */

import type { Brand } from "./brand";
import { type Codec, brandedInteger } from "./codec";

export type LockEpoch = Brand<number, "LockEpoch">;

export const LockEpoch: Codec<LockEpoch> = brandedInteger<LockEpoch>({
  label: "Lock epoch",
  code: "LOCK_EPOCH_INVALID",
  min: 1,
  max: Number.MAX_SAFE_INTEGER,
});
