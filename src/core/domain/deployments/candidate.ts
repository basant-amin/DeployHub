/**
 * `CandidateContainer` — the new container this deployment started.
 *
 * Under the classic strategy (`docs/architecture/decisions.md` § D12) it is a candidate
 * only in the sense that it has not yet proved itself: it takes the previous container's
 * name and published port, so it is serving traffic from the moment it starts, and a crash
 * on boot is an outage rather than a discarded image. That is the accepted cost of matching
 * the manual `docker stop`/`docker run` workflow, and it is why a health check failure now
 * triggers a rollback instead of a bare failure.
 *
 * The name is kept from the superseded candidate-then-promote design (D8) rather than
 * renamed: it is a field in the persisted deployment snapshot, and renaming it would be a
 * storage migration in exchange for a better word.
 *
 * Its upstream is the address the container is published on, which is what the health probe
 * targets.
 */

import {
  type ContainerId,
  type ContainerName,
  type Result,
  ContainerId as ContainerIdCodec,
  ContainerName as ContainerNameCodec,
  combineFields,
  ok,
} from "@/core/shared";

import { ProxyUpstream } from "./baseline";

export interface CandidateContainerInput {
  readonly id: unknown;
  readonly name: unknown;
  readonly upstream: { readonly host: unknown; readonly port: unknown };
}

export class CandidateContainer {
  private constructor(
    readonly id: ContainerId,
    readonly name: ContainerName,
    readonly upstream: ProxyUpstream,
  ) {}

  static create(input: CandidateContainerInput): Result<CandidateContainer> {
    const fields = combineFields("CANDIDATE_INVALID", "Invalid candidate container", {
      id: ContainerIdCodec.parse(input.id),
      name: ContainerNameCodec.parse(input.name),
      upstream: ProxyUpstream.create(input.upstream ?? { host: undefined, port: undefined }),
    });
    return fields.ok
      ? ok(new CandidateContainer(fields.value.id, fields.value.name, fields.value.upstream))
      : fields;
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return { id: this.id, name: this.name, upstream: this.upstream.toJSON() };
  }
}
