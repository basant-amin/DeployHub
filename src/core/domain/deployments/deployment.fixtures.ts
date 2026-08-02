/**
 * Test fixtures for the deployments context.
 *
 * Not part of the production surface — nothing outside a test imports this. It uses
 * `unwrapOrThrow` freely, which is exactly the boundary that escape hatch exists for:
 * a fixture that fails to build is a broken test, not a runtime failure to handle.
 */

import {
  type Actor,
  type CommitSha,
  type DeploymentId,
  type GitRef,
  type IdempotencyKey,
  type ImageDigest,
  type LockEpoch,
  type ProjectId,
  type ReleaseId,
  Actor as ActorCodec,
  CommitSha as CommitShaCodec,
  DeploymentError,
  DeploymentId as DeploymentIdCodec,
  GitRef as GitRefCodec,
  IdempotencyKey as IdempotencyKeyCodec,
  ImageDigest as ImageDigestCodec,
  ImageReference,
  LockEpoch as LockEpochCodec,
  ProjectId as ProjectIdCodec,
  ReleaseId as ReleaseIdCodec,
  Timestamp,
  unwrapOrThrow,
} from "@/core/shared";
import { Project } from "@/core/domain/projects";

import { type Baseline, type ExistingBaseline, Baselines } from "./baseline";
import { CandidateContainer } from "./candidate";
import { Deployment } from "./deployment";
import type { DeploymentState } from "./deployment-state";
import type { Release } from "./release";

/** A fixed instant, offset by whole seconds. The domain never reads a clock. */
const T0 = 1_760_000_000_000;

export function at(offsetSeconds: number): Timestamp {
  return unwrapOrThrow(Timestamp.fromEpochMillis(T0 + offsetSeconds * 1000));
}

export const projectId: ProjectId = unwrapOrThrow(ProjectIdCodec.parse("prj-one-community"));
export const deploymentId: DeploymentId = unwrapOrThrow(DeploymentIdCodec.parse("dep-00000001"));
export const releaseId: ReleaseId = unwrapOrThrow(ReleaseIdCodec.parse("rel-00000001"));
export const actor: Actor = unwrapOrThrow(ActorCodec.parse("basant@elemta.com"));
export const idempotencyKey: IdempotencyKey = unwrapOrThrow(
  IdempotencyKeyCodec.parse("click-0000000001"),
);
export const targetRef: GitRef = unwrapOrThrow(GitRefCodec.parse("main"));
export const lockEpoch: LockEpoch = unwrapOrThrow(LockEpochCodec.parse(7));

export function sha(fill: string): CommitSha {
  return unwrapOrThrow(CommitShaCodec.parse(fill.repeat(40).slice(0, 40)));
}

export function digest(fill: string): ImageDigest {
  return unwrapOrThrow(ImageDigestCodec.parse(`sha256:${fill.repeat(64).slice(0, 64)}`));
}

/** A content address that tracks the commit, as a real digest does. */
export function digestFor(commitSha: CommitSha): ImageDigest {
  return digest(commitSha.slice(0, 1));
}

export const previousSha = sha("a");
export const newSha = sha("b");

export function imageFor(commitSha: CommitSha): ImageReference {
  return unwrapOrThrow(ImageReference.parse(`deployhub/one-community:${commitSha}`));
}

export const image = imageFor(newSha);

export const existingBaseline: ExistingBaseline = unwrapOrThrow(
  Baselines.existing({
    containerId: "a".repeat(12),
    containerName: "one-community",
    image: imageFor(previousSha),
    imageDigest: digest("c"),
    commitSha: previousSha,
    upstream: { host: "127.0.0.1", port: 3001 },
  }),
);

export const candidate: CandidateContainer = unwrapOrThrow(
  CandidateContainer.create({
    id: "b".repeat(12),
    name: "one-community-candidate-dep-00000001",
    upstream: { host: "127.0.0.1", port: 3002 },
  }),
);

export const validRawConfig = Object.freeze({
  repositoryUrl: "git@github.com:elemta/one-community.git",
  gitCredentialRef: "one-community.git.credentials",
  targetRef: "main",
  dockerfilePath: "Dockerfile",
  buildContext: ".",
  buildArgs: { NODE_ENV: "production" },
  runtimeEnvRef: "one-community.runtime.env",
  containerName: "one-community",
  containerPort: 3000,
  route: { host: "app.onecommunity.example", path: "/" },
  healthCheck: {
    path: "/healthz",
    expectedStatus: 200,
    intervalMillis: 1000,
    requiredConsecutivePasses: 3,
    totalBudgetMillis: 60_000,
  },
  imageRepository: "deployhub/one-community",
  imageRetention: 5,
});

export function makeProject(overrides: Readonly<Record<string, unknown>> = {}): Project {
  return unwrapOrThrow(
    Project.create({
      id: "prj-one-community",
      name: "One Community",
      slug: "one-community",
      config: validRawConfig,
      ...overrides,
    }),
  );
}

export function queuedDeployment(
  overrides: Partial<Parameters<typeof Deployment.request>[0]> = {},
): Deployment {
  return unwrapOrThrow(
    Deployment.request({
      id: deploymentId,
      projectId,
      trigger: "manual",
      actor,
      targetRef,
      idempotencyKey,
      requestedAt: at(0),
      ...overrides,
    }),
  );
}

export interface DriveOptions {
  readonly baseline?: Baseline;
  /** The commit the target ref resolves to. Defaults to a sha unlike the baseline's. */
  readonly resolvedSha?: CommitSha;
}

/**
 * Drive a deployment along the happy path to `target`.
 *
 * Every step is a real transition through the public API — the fixture cannot place a
 * deployment in a state the lifecycle would not allow, which is what makes tests
 * built on it trustworthy.
 */
export function driveTo(target: DeploymentState, options: DriveOptions = {}): Deployment {
  const baseline = options.baseline ?? existingBaseline;
  const resolvedSha = options.resolvedSha ?? newSha;
  let current = queuedDeployment();
  let clock = 1;
  const step = (result: ReturnType<Deployment["startValidation"]>): Deployment => {
    if (!result.ok) {
      throw new Error(`fixture could not reach "${target}": ${result.error.message}`);
    }
    return result.value;
  };

  if (target === "queued") {
    return current;
  }

  current = step(current.startValidation(at(clock++)));
  if (target === "validating") return current;

  current = step(current.beginPreparation(at(clock++), lockEpoch));
  if (target === "preparing") return current;

  current = step(current.captureBaseline(at(clock++), baseline));
  if (target === "fetching") return current;

  current = step(current.recordResolvedSource(at(clock++), resolvedSha));
  current = step(current.beginBuild(at(clock++)));
  if (target === "building") return current;

  current = step(
    current.recordImageBuilt(at(clock++), imageFor(resolvedSha), digestFor(resolvedSha)),
  );
  current = step(current.beginCandidateStart(at(clock++)));
  if (target === "starting") return current;

  current = step(current.recordCandidateStarted(at(clock++), candidate));
  current = step(current.beginHealthCheck(at(clock++)));
  if (target === "health_checking") return current;

  // The two pre-promotion terminal outcomes, taken from the last state that allows
  // them. Both leave the previous release serving traffic.
  if (target === "failed") return step(current.fail(at(clock++), healthCheckFailure()));
  if (target === "canceled") return step(current.cancel(at(clock++)));

  current = step(current.recordHealthCheckPassed(at(clock++)));
  current = step(current.beginPromotion(at(clock++)));
  if (target === "promoting") return current;

  if (target === "rolling_back" || target === "rolled_back" || target === "rollback_failed") {
    current = step(current.beginRollback(at(clock++), rollbackTrigger()));
    if (target === "rolling_back") return current;
    return target === "rolled_back"
      ? step(current.completeRollback(at(clock++)))
      : step(current.failRollback(at(clock++), rollbackTrigger()));
  }

  current = step(current.recordRouteVerified(at(clock++)));
  current = step(current.beginFinalization(at(clock++)));
  if (target === "finalizing") return current;

  current = step(current.succeed(at(clock++)));
  if (target === "succeeded") return current;

  throw new Error(`driveTo does not build a path to "${target}"`);
}

/** A shipped release, for rollback-eligibility tests. Distinct commit per id. */
export function releaseFrom(id: string, commitSha: CommitSha): Release {
  const deployed = driveTo("succeeded", { resolvedSha: commitSha });
  const release = deployed.toRelease(unwrapOrThrow(ReleaseIdCodec.parse(id)));
  if (!release.ok) {
    throw new Error(`fixture release failed: ${release.error.message}`);
  }
  return release.value;
}

/** A representative post-promotion failure, for rollback paths. */
export function rollbackTrigger(): DeploymentError {
  return DeploymentError.of("ROUTE_VERIFICATION_FAILED", "route returned 502 after promotion");
}

/** A representative pre-promotion failure, for discard paths. */
export function healthCheckFailure(): DeploymentError {
  return DeploymentError.of("HEALTH_CHECK_FAILED", "candidate never became healthy");
}
