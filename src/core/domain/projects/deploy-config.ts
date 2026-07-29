/**
 * `DeployConfig` — everything needed to deploy a project, validated as a whole.
 *
 * Note what is absent: timeouts, retry counts, and pruning behavior. Those are
 * platform policy, tuned once for every project, not per-project configuration. What
 * lives here is only what genuinely differs between projects.
 *
 * Also absent: any secret value. Credentials appear as `SecretRef` pointers, resolved
 * at the moment of use, so a config object can be logged or persisted without leaking
 * anything.
 *
 * There are no cross-field rules. The two the architecture names as configuration
 * errors — a health path with no port, a route with no upstream — are unrepresentable
 * here because both fields are required, which is a better outcome than validating
 * for them. The remaining candidates (a Dockerfile outside its build context, two
 * secret references being equal) are conventions rather than invariants: `docker build
 * -f ../Dockerfile ctx` is legal, and a project may legitimately keep its git
 * credential and runtime environment in one secret bundle. Enforcing either here
 * would reject a working configuration.
 */

import {
  type GitRef,
  type GitRepositoryUrl,
  type ImageRepository,
  type RelativePath,
  type Result,
  type SecretRef,
  ContainerPort,
  GitRef as GitRefCodec,
  GitRepositoryUrl as GitRepositoryUrlCodec,
  ImageRepository as ImageRepositoryCodec,
  RelativePath as RelativePathCodec,
  SecretRef as SecretRefCodec,
  asRecord,
  combineFields,
  ok,
} from "@/core/shared";

import { BuildArgs } from "./build-args";
import { HealthCheckSpec } from "./health-check-spec";
import { ImageRetention } from "./image-retention";
import { PublicRoute } from "./public-route";

export interface DeployConfigInput {
  readonly repositoryUrl: unknown;
  /** Pointer to the git credential, never the credential. */
  readonly gitCredentialRef: unknown;
  /** The branch, tag, or sha deploys default to. Resolved per deployment. */
  readonly targetRef: unknown;
  /** Workspace-relative path to the Dockerfile. */
  readonly dockerfilePath: unknown;
  /** Workspace-relative build context. `.` for the repository root. */
  readonly buildContext: unknown;
  readonly buildArgs?: unknown;
  /** Pointer to the runtime environment for the container. */
  readonly runtimeEnvRef: unknown;
  /** The port the application listens on inside the container. */
  readonly containerPort: unknown;
  readonly route: unknown;
  readonly healthCheck: unknown;
  /** Where built images are named, e.g. `deployhub/one-community`. */
  readonly imageRepository: unknown;
  readonly imageRetention: unknown;
}

export class DeployConfig {
  private constructor(
    readonly repositoryUrl: GitRepositoryUrl,
    readonly gitCredentialRef: SecretRef,
    readonly targetRef: GitRef,
    readonly dockerfilePath: RelativePath,
    readonly buildContext: RelativePath,
    readonly buildArgs: BuildArgs,
    readonly runtimeEnvRef: SecretRef,
    readonly containerPort: ContainerPort,
    readonly route: PublicRoute,
    readonly healthCheck: HealthCheckSpec,
    readonly imageRepository: ImageRepository,
    readonly imageRetention: ImageRetention,
  ) {}

  static create(raw: unknown): Result<DeployConfig> {
    const record = asRecord(raw, "DEPLOY_CONFIG_INVALID", "Deploy config");
    if (!record.ok) {
      return record;
    }
    const input = record.value as unknown as DeployConfigInput;

    const fields = combineFields("DEPLOY_CONFIG_INVALID", "Invalid deploy config", {
      repositoryUrl: GitRepositoryUrlCodec.parse(input.repositoryUrl),
      gitCredentialRef: SecretRefCodec.parse(input.gitCredentialRef),
      targetRef: GitRefCodec.parse(input.targetRef),
      dockerfilePath: RelativePathCodec.parse(input.dockerfilePath),
      buildContext: RelativePathCodec.parse(input.buildContext),
      buildArgs: BuildArgs.create(input.buildArgs),
      runtimeEnvRef: SecretRefCodec.parse(input.runtimeEnvRef),
      containerPort: ContainerPort.parse(input.containerPort),
      route: PublicRoute.create(input.route),
      healthCheck: HealthCheckSpec.create(input.healthCheck),
      imageRepository: ImageRepositoryCodec.parse(input.imageRepository),
      imageRetention: ImageRetention.parse(input.imageRetention),
    });
    if (!fields.ok) {
      return fields;
    }

    return ok(
      new DeployConfig(
        fields.value.repositoryUrl,
        fields.value.gitCredentialRef,
        fields.value.targetRef,
        fields.value.dockerfilePath,
        fields.value.buildContext,
        fields.value.buildArgs,
        fields.value.runtimeEnvRef,
        fields.value.containerPort,
        fields.value.route,
        fields.value.healthCheck,
        fields.value.imageRepository,
        fields.value.imageRetention,
      ),
    );
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return {
      repositoryUrl: this.repositoryUrl,
      gitCredentialRef: this.gitCredentialRef,
      targetRef: this.targetRef,
      dockerfilePath: this.dockerfilePath,
      buildContext: this.buildContext,
      buildArgs: this.buildArgs.toJSON(),
      runtimeEnvRef: this.runtimeEnvRef,
      containerPort: this.containerPort,
      route: this.route.toJSON(),
      healthCheck: this.healthCheck.toJSON(),
      imageRepository: this.imageRepository,
      imageRetention: this.imageRetention,
    };
  }
}
