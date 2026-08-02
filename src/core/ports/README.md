# `core/ports` — the seam

Every capability the application layer depends on, expressed as an interface in the
engine's language rather than a vendor's. Implemented in `server/adapters/`, never in
`core/` (test fakes excepted).

Ports are **declarations**: no logic, no defaults, no retry behaviour. A port that
decided something would be a policy in the wrong layer.

| Port                   | Capability                                                   | Adapter (Phase 4D) | Consumer (Phase 4C)           |
| ---------------------- | ------------------------------------------------------------ | ------------------ | ----------------------------- |
| `Clock`                | The current instant; waiting                                 | `local/`           | Engine runner, reconciler     |
| `IdGenerator`          | Deployment and release ids                                   | `local/`           | `RequestDeployment`, finalize |
| `ProjectRepository`    | Load and save projects                                       | `persistence/`     | All use cases                 |
| `DeploymentRepository` | Persist the aggregate; find queued, active, unfinished       | `persistence/`     | Admission, worker, reconciler |
| `ReleaseRepository`    | Persist releases; find the live one                          | `persistence/`     | Finalize, rollback, retention |
| `DeployLock`           | Leased, fenced, single-writer lock                           | `lock/`            | Engine lock step, reconciler  |
| `GitClient`            | Put the workspace at a ref; return the resolved sha          | `git/`             | Engine update-source step     |
| `ContainerRuntime`     | Build, start, inspect, rename, stop, remove, prune, headroom | `docker/`          | Engine build → finalize steps |
| `HealthProbe`          | One probe attempt, one result                                | `health/`          | Health policy                 |
| `DeploymentLogSink`    | Open with a redactor, append, complete, read, tail           | `logs/`            | Engine runner, log viewer     |
| `EventPublisher`       | Announce a state or step change                              | `events/`          | Engine runner                 |
| `SecretProvider`       | Resolve a credential or environment by reference             | `secrets/`         | Preflight, build, start steps |

## Two ports carry the platform's future

`ContainerRuntime` is exactly what a Kubernetes adapter would
implement. Keeping them orchestrator-neutral in naming and granularity is the entire
cost of preserving that option, and it is why neither mentions Docker, a socket, or a
config file.

## Deliberately absent

- **`CommandRunner`.** Running a process on a host is a transport the git, container,
  and proxy adapters share; the application layer never calls it. It belongs inside
  `server/adapters/`, not at a boundary the engine depends on — declaring it here would
  invert a dependency that does not cross the layer. Decision D3 stands: SSH is a
  transport the tool adapters compose, not a peer capability.
- **An image registry port.** Release 1 builds on the host it deploys to. Registry push
  and pull are a named extension point that adds methods to `ContainerRuntime`.
- **A filesystem or workspace port.** The workspace exists only in service of a
  checkout, so `GitClient` owns it; free space is reported by `ContainerRuntime`, the
  thing that consumes it.
- **A queue or worker-coordination port.** Release 1 rejects concurrent deploys rather
  than queueing them (§ D6), so the worker's coordination need is one query:
  `DeploymentRepository.findQueued`.
- **Internal port allocation.** Only the host knows which ports are free, so
  `ContainerRuntime.startContainer` reports the address it actually bound.

Full boundary: [`docs/architecture/modules.md`](../../../docs/architecture/modules.md#coreports--the-seam).
