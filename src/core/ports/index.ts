/**
 * The ports layer — every capability the application layer depends on, expressed as an
 * interface in the engine's language rather than a vendor's.
 *
 * These are declarations. There is no logic here, no default, and no retry behaviour;
 * a port that decided something would be a policy in the wrong layer. Nothing in
 * `core/` implements them except test fakes.
 *
 * Two ports carry the platform's future: `ContainerRuntime` and `ReverseProxy` are
 * exactly what a Kubernetes adapter would implement, which is why they are written in
 * orchestrator-neutral terms and nothing else needs to change when that day comes.
 *
 * Notably absent, each for a stated reason:
 *
 * - **`CommandRunner`.** Running a process on a host is a transport concern that the
 *   git, container, and proxy adapters share; the application layer never calls it. It
 *   belongs inside `server/adapters/`, not at a boundary the engine depends on —
 *   declaring it here would invert a dependency that does not cross the layer.
 * - **An image registry port.** Release 1 builds on the host it deploys to. Registry
 *   push and pull are a named extension point that adds methods to `ContainerRuntime`.
 * - **A filesystem or workspace port.** The workspace exists only in service of a
 *   checkout, so `GitClient` owns it; free space is reported by `ContainerRuntime`,
 *   which is the thing that consumes it.
 * - **A queue or worker-coordination port.** Release 1 rejects concurrent deploys
 *   rather than queueing them, so the worker's coordination need is one query —
 *   `DeploymentRepository.findQueued`.
 */

export type { Clock } from "./clock";
export type { IdGenerator } from "./id-generator";

export type { ProjectRepository, DeploymentRepository, ReleaseRepository } from "./repositories";

export type { AcquireLeaseRequest, DeployLease, DeployLock, WorkerId } from "./deploy-lock";

export type { GitClient } from "./git-client";

export type {
  BuiltImage,
  ContainerRuntime,
  ContainerSnapshot,
  ContainerStartRequest,
  ContainerState,
  ImageBuildRequest,
  StorageHeadroom,
} from "./container-runtime";

export type { ReverseProxy } from "./reverse-proxy";

export type { HealthProbe, ProbeOutcome, ProbeRequest, ProbeTarget } from "./health-probe";

export type { DeploymentLogLine, DeploymentLogSink, LogStream } from "./log-sink";

export type { DeploymentEvent, EventPublisher } from "./event-publisher";

export type { SecretProvider } from "./secret-provider";
