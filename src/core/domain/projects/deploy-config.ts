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
 * There is **one** cross-field rule: the git authentication method must match the transport its
 * repository URL implies. It earns its place because the alternative is a deployment that fails
 * minutes in, at the fetch step, with a message about a credential rather than about the
 * configuration that could never have worked — and because both halves are needed to see it, so no
 * per-field check can. Everything else that looks like a candidate is not one. The two the
 * architecture names as configuration errors — a health path with no port, a route with no
 * upstream — are unrepresentable here because both fields are required. The rest (a Dockerfile
 * outside its build context, two secret references being equal) are conventions rather than
 * invariants: `docker build -f ../Dockerfile ctx` is legal, and a project may legitimately keep its
 * git credential and runtime environment in one secret bundle. Enforcing those would reject a
 * working configuration.
 */

import {
  type GitRef,
  type GitRepositoryUrl,
  type ImageRepository,
  type RelativePath,
  type Result,
  type SecretRef,
  ContainerName,
  ContainerPort,
  GitRef as GitRefCodec,
  GitRepositoryUrl as GitRepositoryUrlCodec,
  ImageRepository as ImageRepositoryCodec,
  RelativePath as RelativePathCodec,
  SecretRef as SecretRefCodec,
  asRecord,
  checkCrossField,
  combineFields,
  gitTransportOf,
  ok,
} from "@/core/shared";

import { BuildArgs } from "./build-args";
import { GitAuth } from "./git-auth";
import { HealthCheckSpec } from "./health-check-spec";
import { ImageRetention } from "./image-retention";
import { PublicRoute } from "./public-route";

export interface DeployConfigInput {
  readonly repositoryUrl: unknown;
  /** Pointer to the git credential, never the credential. */
  readonly gitCredentialRef: unknown;
  /**
   * How that credential is presented. Optional on input only so a project stored before the field
   * existed still loads — see `GitAuth.legacyDefault`.
   */
  readonly gitAuth?: unknown;
  /** The branch, tag, or sha deploys default to. Resolved per deployment. */
  readonly targetRef: unknown;
  /** Workspace-relative path to the Dockerfile. */
  readonly dockerfilePath: unknown;
  /** Workspace-relative build context. `.` for the repository root. */
  readonly buildContext: unknown;
  readonly buildArgs?: unknown;
  /** Pointer to the runtime environment for the container. */
  readonly runtimeEnvRef: unknown;
  /**
   * The name the deployed container runs under.
   *
   * Configuration rather than a derived value, because on a host that already runs the
   * application the name is a fact about that host — `one-community` — not something the
   * platform gets to choose. Registration defaults it to the slug, which is what a project
   * created from scratch wants.
   *
   * Stable for the life of the project. It identifies the running container to `stop`,
   * `rm`, and `run`, and to baseline capture, so changing it would not rename anything —
   * it would orphan whatever is running under the old name and then collide with it on
   * the published port.
   */
  readonly containerName: unknown;
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
    readonly gitAuth: GitAuth,
    readonly targetRef: GitRef,
    readonly dockerfilePath: RelativePath,
    readonly buildContext: RelativePath,
    readonly buildArgs: BuildArgs,
    readonly runtimeEnvRef: SecretRef,
    readonly containerName: ContainerName,
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
      gitAuth:
        input.gitAuth === undefined ? ok(GitAuth.legacyDefault()) : GitAuth.create(input.gitAuth),
      targetRef: GitRefCodec.parse(input.targetRef),
      dockerfilePath: RelativePathCodec.parse(input.dockerfilePath),
      buildContext: RelativePathCodec.parse(input.buildContext),
      buildArgs: BuildArgs.create(input.buildArgs),
      runtimeEnvRef: SecretRefCodec.parse(input.runtimeEnvRef),
      containerName: ContainerName.parse(input.containerName),
      containerPort: ContainerPort.parse(input.containerPort),
      route: PublicRoute.create(input.route),
      healthCheck: HealthCheckSpec.create(input.healthCheck),
      imageRepository: ImageRepositoryCodec.parse(input.imageRepository),
      imageRetention: ImageRetention.parse(input.imageRetention),
    });
    if (!fields.ok) {
      return fields;
    }

    const config = new DeployConfig(
      fields.value.repositoryUrl,
      fields.value.gitCredentialRef,
      fields.value.gitAuth,
      fields.value.targetRef,
      fields.value.dockerfilePath,
      fields.value.buildContext,
      fields.value.buildArgs,
      fields.value.runtimeEnvRef,
      fields.value.containerName,
      fields.value.containerPort,
      fields.value.route,
      fields.value.healthCheck,
      fields.value.imageRepository,
      fields.value.imageRetention,
    );

    // The one cross-field rule. A token cannot authenticate an SSH connection and a deploy key
    // cannot authenticate an HTTPS one, so this combination is not merely unusual — it can never
    // succeed. Reported under `gitAuth.method` so it lands on the input an operator can change,
    // and reported here so it is caught when the project is saved rather than at the fetch step of
    // a deployment that has already been queued, locked, and started.
    const wanted = config.gitAuth.transport;
    const actual = gitTransportOf(config.repositoryUrl);
    const issues =
      wanted === actual
        ? []
        : [
            `gitAuth.method: ${config.gitAuth.method} authenticates over ${wanted}, but the repository URL is ${actual}. ${
              wanted === "ssh"
                ? "Use the SSH clone URL (git@github.com:owner/repo.git), or change the method to https-token"
                : "Use the https:// clone URL, or change the method to ssh-deploy-key"
            }`,
          ];

    return checkCrossField("DEPLOY_CONFIG_INVALID", "Invalid deploy config", config, issues);
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return {
      repositoryUrl: this.repositoryUrl,
      gitCredentialRef: this.gitCredentialRef,
      gitAuth: this.gitAuth.toJSON(),
      targetRef: this.targetRef,
      dockerfilePath: this.dockerfilePath,
      buildContext: this.buildContext,
      buildArgs: this.buildArgs.toJSON(),
      runtimeEnvRef: this.runtimeEnvRef,
      containerName: this.containerName,
      containerPort: this.containerPort,
      route: this.route.toJSON(),
      healthCheck: this.healthCheck.toJSON(),
      imageRepository: this.imageRepository,
      imageRetention: this.imageRetention,
    };
  }
}
