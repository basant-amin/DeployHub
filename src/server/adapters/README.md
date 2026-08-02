# `server/adapters` — port implementations

One subdirectory per adapter. Each implements a `core/ports` interface and contains
no decision-making: adapters do what they are told and report what happened.

| Directory      | Implements         | Notes                                             |
| -------------- | ------------------ | ------------------------------------------------- |
| `ssh/`         | `CommandRunner`    | Transport. Knows nothing about git or docker.     |
| `local/`       | `CommandRunner`    | `child_process` — development and tests.          |
| `git/`         | `GitClient`        | Built on `CommandRunner`.                         |
| `docker/`      | `ContainerRuntime` | Built on `CommandRunner`. Owns naming + labels.   |
| `health/`      | `HealthProbe`      | One probe, one result. No loops, no thresholds.   |
| `logs/`        | `LogSink`          | Append-only; redaction at the boundary.           |
| `lock/`        | `DeployLock`       | Persisted lease + fencing epoch + remote `flock`. |
| `persistence/` | repositories       | Owns schema and migrations.                       |

`ssh` is a **transport**, not a peer of `git` and `docker` — the tool adapters
compose `CommandRunner` instead of doing their own connection handling. Rationale:
[`decisions.md` § D3](../../../docs/architecture/decisions.md#d3--ssh-is-a-transport-not-a-capability-module).

Adapters are selected and injected only by `server/runtime`'s composition root.
Nothing in `features/` or `app/` may import from here.

Per-adapter boundaries:
[`docs/architecture/modules.md`](../../../docs/architecture/modules.md#serveradaptersssh-and-serveradapterslocal--transport).
