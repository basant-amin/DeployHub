/**
 * `Release` — the durable record of something that actually shipped.
 *
 * Distinct from a deployment on purpose. A deployment is an attempt, and most of the
 * interesting ones failed; a release is the subset that reached production and was
 * verified there. Rollback targets are chosen from releases, which is why a release
 * cannot be constructed from a failed deployment — the only way to obtain one is
 * `Deployment.toRelease`, and that requires a verified success.
 *
 * A release carries the image **digest**, so "deploy this release again" is
 * unambiguous even if every tag on the host has since been reassigned.
 */

import {
  type Actor,
  type CommitSha,
  type ContainerId,
  type DeploymentId,
  type ImageDigest,
  type ProjectId,
  type ReleaseId,
  type Result,
  Actor as ActorCodec,
  CommitSha as CommitShaCodec,
  ContainerId as ContainerIdCodec,
  DeploymentId as DeploymentIdCodec,
  Duration,
  ImageDigest as ImageDigestCodec,
  ImageReference,
  ProjectId as ProjectIdCodec,
  ReleaseId as ReleaseIdCodec,
  Timestamp,
  combineFields,
  ok,
} from "@/core/shared";

export interface ReleaseInput {
  readonly id: unknown;
  readonly projectId: unknown;
  readonly deploymentId: unknown;
  readonly commitSha: unknown;
  readonly image: ImageReference | unknown;
  readonly imageDigest: unknown;
  readonly containerId: unknown;
  readonly actor: unknown;
  readonly deployedAt: Timestamp;
  readonly duration: Duration;
}

export class Release {
  private constructor(
    readonly id: ReleaseId,
    readonly projectId: ProjectId,
    /** The deployment that produced it. One release per successful deployment. */
    readonly deploymentId: DeploymentId,
    readonly commitSha: CommitSha,
    readonly image: ImageReference,
    readonly imageDigest: ImageDigest,
    readonly containerId: ContainerId,
    readonly actor: Actor,
    readonly deployedAt: Timestamp,
    /** Wall-clock time of the deployment that produced this release. */
    readonly duration: Duration,
  ) {}

  static create(input: ReleaseInput): Result<Release> {
    const fields = combineFields("RELEASE_INVALID", "Invalid release", {
      id: ReleaseIdCodec.parse(input.id),
      projectId: ProjectIdCodec.parse(input.projectId),
      deploymentId: DeploymentIdCodec.parse(input.deploymentId),
      commitSha: CommitShaCodec.parse(input.commitSha),
      image:
        input.image instanceof ImageReference ? ok(input.image) : ImageReference.parse(input.image),
      imageDigest: ImageDigestCodec.parse(input.imageDigest),
      containerId: ContainerIdCodec.parse(input.containerId),
      actor: ActorCodec.parse(input.actor),
    });
    if (!fields.ok) {
      return fields;
    }
    return ok(
      new Release(
        fields.value.id,
        fields.value.projectId,
        fields.value.deploymentId,
        fields.value.commitSha,
        fields.value.image,
        fields.value.imageDigest,
        fields.value.containerId,
        fields.value.actor,
        input.deployedAt,
        input.duration,
      ),
    );
  }

  /** Whether this release shipped the same commit as another. */
  hasSameCommit(other: Release): boolean {
    return this.commitSha === other.commitSha;
  }

  equals(other: Release): boolean {
    return this.id === other.id;
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return {
      id: this.id,
      projectId: this.projectId,
      deploymentId: this.deploymentId,
      commitSha: this.commitSha,
      image: this.image.toString(),
      imageDigest: this.imageDigest,
      containerId: this.containerId,
      actor: this.actor,
      deployedAt: this.deployedAt.epochMillis,
      durationMillis: this.duration.millis,
    };
  }
}
