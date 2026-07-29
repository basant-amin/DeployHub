/**
 * `ContainerRuntime` — build images, run containers, and report what is on the host.
 *
 * With `ReverseProxy`, this is the port that carries the platform's future: a
 * Kubernetes or Swarm adapter implements these two and nothing else changes
 * (`docs/architecture/README.md` § Extension points). Every signature is therefore
 * written in orchestrator-neutral terms — build a thing, start a thing, tell me what is
 * running — and never in Docker's.
 *
 * The port makes no decisions. It does not choose which images to remove, does not
 * judge whether a container is healthy, and does not stop the live container on its own
 * initiative. Destructive operations are always explicitly targeted by the caller,
 * because a runtime that decides what to delete is a runtime that will one day delete
 * the wrong thing.
 *
 * Registry push and pull are deliberately absent. Release 1 builds on the host it
 * deploys to; registry-based builds are a named extension point that adds methods here
 * when it arrives, and adding them now would be two unimplemented methods and a
 * guessed signature.
 */

import type {
  Actor,
  CommitSha,
  ContainerId,
  ContainerName,
  DeploymentId,
  Duration,
  ImageDigest,
  ImageReference,
  Result,
} from "@/core/shared";
import type { Project, ProxyUpstream } from "@/core/domain";

/**
 * What a container is doing, in terms the flow actually branches on.
 *
 * A discriminated union rather than a string, because "exited" carries an exit code
 * and "restarting" carries a restart count, and the engine needs both: a container
 * that exited immediately and one caught in a restart loop are different failures with
 * the same visible symptom.
 */
export type ContainerState =
  | { readonly kind: "starting" }
  | { readonly kind: "running" }
  | { readonly kind: "restarting"; readonly restarts: number }
  | { readonly kind: "stopped" }
  | { readonly kind: "exited"; readonly exitCode: number };

/**
 * A container on the host, as the platform sees it.
 *
 * The commit and deployment id come from labels the runtime applied at build and start
 * time. That is what makes the host readable back to a deployment record without a
 * database, and therefore what makes crash recovery possible at all.
 */
export interface ContainerSnapshot {
  readonly id: ContainerId;
  readonly name: ContainerName;
  readonly state: ContainerState;
  readonly image: ImageReference;
  readonly imageDigest: ImageDigest;
  readonly commitSha: CommitSha;
  readonly deploymentId: DeploymentId;
  /** The address it can be reached at, absent when it is not running. */
  readonly upstream: ProxyUpstream | undefined;
}

export interface ImageBuildRequest {
  readonly project: Project;
  /** The commit to build. Immutable, and recorded as a label on the result. */
  readonly commitSha: CommitSha;
  readonly deploymentId: DeploymentId;
  /** Recorded as a label, so an orphaned image can be traced to who caused it. */
  readonly actor: Actor;
}

export interface BuiltImage {
  readonly reference: ImageReference;
  readonly digest: ImageDigest;
}

export interface ContainerStartRequest {
  readonly project: Project;
  readonly name: ContainerName;
  readonly image: ImageReference;
  /**
   * The digest to run.
   *
   * Present alongside the reference because the digest is what identifies the image
   * unambiguously — a tag can be reassigned. It is also what lets recovery restart a
   * previous release whose container was destroyed but whose image survives.
   */
  readonly imageDigest: ImageDigest;
  readonly commitSha: CommitSha;
  readonly deploymentId: DeploymentId;
  /** Resolved runtime environment. The engine resolves it; this port never reads a secret. */
  readonly environment: ReadonlyMap<string, string>;
}

/** Free space on the host, for the preflight check that a build cannot fill the disk. */
export interface StorageHeadroom {
  readonly freeBytes: number;
  readonly totalBytes: number;
}

export interface ContainerRuntime {
  /** Build an image from the project's source, labelled with commit and deployment. */
  buildImage(request: ImageBuildRequest): Promise<Result<BuiltImage>>;

  /**
   * Start a container and report the address it bound.
   *
   * The runtime allocates the internal port, because only the host knows which ports
   * are free — asking a caller to pick one invites a collision the caller cannot see.
   *
   * Serves both the candidate start and, during recovery, restarting a previous
   * release from its digest.
   */
  startContainer(request: ContainerStartRequest): Promise<Result<ContainerSnapshot>>;

  /** Current state of one container, or `undefined` if it no longer exists. */
  inspect(id: ContainerId): Promise<Result<ContainerSnapshot | undefined>>;

  /**
   * Every container this platform created for a project, running or not.
   *
   * The reconciler reads the host through this rather than trusting the deployment
   * record, because when the two disagree the host is the one that is true.
   */
  findForProject(project: Project): Promise<Result<readonly ContainerSnapshot[]>>;

  /** Rename, so container names keep matching reality across a promotion. */
  rename(id: ContainerId, name: ContainerName): Promise<Result<void>>;

  /** Stop, allowing `grace` for a clean shutdown before it is forced. */
  stop(id: ContainerId, grace: Duration): Promise<Result<void>>;

  /** Remove a stopped container. Never called on the live one by this port's choice. */
  remove(id: ContainerId): Promise<Result<void>>;

  /**
   * Recent log output from a container.
   *
   * Called when a candidate fails to start or fails its health check: those logs are
   * the single most useful artifact for diagnosing a bad release, and they are gone
   * once the container is removed.
   */
  readLogs(id: ContainerId, maxLines: number): Promise<Result<readonly string[]>>;

  /**
   * Remove exactly the images named, and nothing else.
   *
   * The engine computes the set from the project's retention setting and its release
   * history. A port that decided for itself would eventually prune something still
   * needed for a rollback.
   */
  removeImages(digests: readonly ImageDigest[]): Promise<Result<void>>;

  /** Free space on the host, for preflight. */
  readStorageHeadroom(): Promise<Result<StorageHeadroom>>;
}
