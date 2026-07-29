# `core/ports` — the seam

Interfaces expressing every capability the engine needs, written in the engine's
language rather than a vendor's. Implemented in `server/adapters/`, never in `core/`
(test fakes excepted).

Planned ports: `CommandRunner`, `GitClient`, `ContainerRuntime`, `ReverseProxy`,
`HealthProbe`, `DeployLock`, `LogSink`, `EventPublisher`, the repositories,
`SecretProvider`, `Clock`, `IdGenerator`.

Ports are declarations: no logic, no defaults, no retry behavior. Vendor types must
not appear in a signature — a port that exposes Docker's inspect output has bought
nothing.

`ContainerRuntime` and `ReverseProxy` are the two interfaces a future Kubernetes
adapter would implement. Keeping their naming and granularity
orchestrator-neutral is the entire cost of preserving that option.

Full list and boundaries:
[`docs/architecture/modules.md`](../../../docs/architecture/modules.md#coreports--the-seam).
