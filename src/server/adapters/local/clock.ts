/**
 * `Clock` and `IdGenerator` — the two ports whose implementation is one line each.
 *
 * They exist as ports because the domain refuses to read a clock or invent an id, not because
 * either is complicated. This file is where the real time and the real entropy enter the
 * system, and it is the only place either does.
 */

import { randomUUID } from "node:crypto";

import {
  type DeploymentId,
  type Duration,
  type ReleaseId,
  type Timestamp,
  DeploymentId as DeploymentIdCodec,
  ReleaseId as ReleaseIdCodec,
  Timestamp as TimestampCodec,
  unwrapOrThrow,
} from "@/core/shared";
import type { Clock, IdGenerator } from "@/core/ports";

export class SystemClock implements Clock {
  now(): Timestamp {
    // `Date.now()` is always a non-negative integer inside the representable range, so this
    // cannot fail. Everything else in the platform reads the clock through here.
    return unwrapOrThrow(TimestampCodec.fromEpochMillis(Date.now()));
  }

  async sleep(duration: Duration): Promise<void> {
    // Deliberately *not* unref'd. A pending sleep is real work: during a health check the timer
    // is often the only thing on the event loop, and unref'ing it makes Node exit mid-deployment
    // — which is exactly what happened the first time this ran against a real host.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, duration.millis);
    });
  }
}

/**
 * UUID v4, prefixed so an id is recognisable in a log line.
 *
 * Hyphens are stripped because the ids appear in container names, and a shorter name is
 * easier to read in `docker ps`. Any of ULID, UUID, or nanoid satisfies the domain's id
 * rules; this is the one with no dependency.
 */
export class UuidIdGenerator implements IdGenerator {
  nextDeploymentId(): DeploymentId {
    return unwrapOrThrow(DeploymentIdCodec.parse(`dep-${compactUuid()}`));
  }

  nextReleaseId(): ReleaseId {
    return unwrapOrThrow(ReleaseIdCodec.parse(`rel-${compactUuid()}`));
  }
}

function compactUuid(): string {
  return randomUUID().replaceAll("-", "");
}
