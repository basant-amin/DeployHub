/**
 * `CandidateContainer` — the new container, running but not yet serving traffic.
 *
 * The candidate is what makes most deployment failures non-events: it is built,
 * started, and health-checked while the previous container keeps serving every
 * request, so a failed build or a crash on boot costs a discarded image rather than
 * an outage (`docs/architecture/decisions.md` § D8).
 *
 * Its upstream is an internal address, unreachable from outside, until promotion
 * points the public route at it.
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
