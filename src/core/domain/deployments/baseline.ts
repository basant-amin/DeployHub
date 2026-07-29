/**
 * `Baseline` — what was live before this deployment touched anything.
 *
 * Captured before any mutation, and the reason rollback is possible at all. It is a
 * discriminated union rather than an optional record because "there is nothing to
 * roll back to" is a real, expected case that must be stated up front: on a first
 * deployment the compensation is "remove the candidate", and discovering that during
 * a failure is far too late.
 *
 * The image **digest** is recorded alongside the tag deliberately. A tag can be
 * reassigned, so returning to "the previous image tag" can silently mean a different
 * image; a digest cannot. It is also what makes the worst recovery case survivable —
 * if the previous container was destroyed, the previous release is still startable.
 */

import {
  type CommitSha,
  type ContainerId,
  type ContainerName,
  type Result,
  CommitSha as CommitShaCodec,
  ContainerId as ContainerIdCodec,
  ContainerName as ContainerNameCodec,
  ContainerPort,
  Hostname,
  ImageDigest,
  ImageReference,
  combineFields,
  ok,
} from "@/core/shared";

/** Where the reverse proxy sends traffic for a route. */
export class ProxyUpstream {
  private constructor(
    readonly host: Hostname,
    readonly port: ContainerPort,
  ) {}

  static create(input: { readonly host: unknown; readonly port: unknown }): Result<ProxyUpstream> {
    const fields = combineFields("PROXY_UPSTREAM_INVALID", "Invalid proxy upstream", {
      host: Hostname.parse(input.host),
      port: ContainerPort.parse(input.port),
    });
    return fields.ok ? ok(new ProxyUpstream(fields.value.host, fields.value.port)) : fields;
  }

  toJSON(): { readonly host: string; readonly port: number } {
    return { host: this.host, port: this.port };
  }
}

/** No previous release exists. Compensation is "remove the candidate". */
export interface FirstDeployBaseline {
  readonly kind: "first_deploy";
}

/** A previous release is live, and this records precisely how to return to it. */
export interface ExistingBaseline {
  readonly kind: "existing";
  readonly containerId: ContainerId;
  readonly containerName: ContainerName;
  readonly image: ImageReference;
  readonly imageDigest: ImageDigest;
  readonly commitSha: CommitSha;
  readonly upstream: ProxyUpstream;
}

export type Baseline = FirstDeployBaseline | ExistingBaseline;

export interface ExistingBaselineInput {
  readonly containerId: unknown;
  readonly containerName: unknown;
  readonly image: unknown;
  readonly imageDigest: unknown;
  readonly commitSha: unknown;
  readonly upstream: { readonly host: unknown; readonly port: unknown };
}

export const Baselines = {
  firstDeploy(): FirstDeployBaseline {
    return Object.freeze({ kind: "first_deploy" } as const);
  },

  existing(input: ExistingBaselineInput): Result<ExistingBaseline> {
    const fields = combineFields("BASELINE_INVALID", "Invalid baseline", {
      containerId: ContainerIdCodec.parse(input.containerId),
      containerName: ContainerNameCodec.parse(input.containerName),
      image:
        input.image instanceof ImageReference ? ok(input.image) : ImageReference.parse(input.image),
      imageDigest: ImageDigest.parse(input.imageDigest),
      commitSha: CommitShaCodec.parse(input.commitSha),
      upstream: ProxyUpstream.create(input.upstream ?? { host: undefined, port: undefined }),
    });
    if (!fields.ok) {
      return fields;
    }
    return ok(
      Object.freeze({
        kind: "existing",
        containerId: fields.value.containerId,
        containerName: fields.value.containerName,
        image: fields.value.image,
        imageDigest: fields.value.imageDigest,
        commitSha: fields.value.commitSha,
        upstream: fields.value.upstream,
      } as const),
    );
  },

  isFirstDeploy(baseline: Baseline): baseline is FirstDeployBaseline {
    return baseline.kind === "first_deploy";
  },

  /** The commit currently live, or `undefined` on a first deployment. */
  liveCommitSha(baseline: Baseline): CommitSha | undefined {
    return baseline.kind === "existing" ? baseline.commitSha : undefined;
  },

  toJSON(baseline: Baseline): Readonly<Record<string, unknown>> {
    if (baseline.kind === "first_deploy") {
      return { kind: baseline.kind };
    }
    return {
      kind: baseline.kind,
      containerId: baseline.containerId,
      containerName: baseline.containerName,
      image: baseline.image.toString(),
      imageDigest: baseline.imageDigest,
      commitSha: baseline.commitSha,
      upstream: baseline.upstream.toJSON(),
    };
  },
} as const;
