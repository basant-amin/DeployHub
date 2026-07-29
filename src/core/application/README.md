# `core/application` — orchestration

- `engine/` — the deployment pipeline: steps, the runner that executes them, and the
  run context. Owns step order, timeouts, retries, compensation, and terminal-state
  selection.
- `use-cases/` — the application's verbs: `RequestDeployment`, `CancelDeployment`,
  `RequestRollback`, `GetDeploymentStatus`, `StreamDeploymentLogs`,
  `RecoverInterruptedDeployments`.
- `policies/` — pure functions for the tunable decisions: health evaluation, retry,
  retention, rollback eligibility, disk headroom. Every tunable number in the
  platform, in one place.

Depends only on `core/domain`, `core/ports`, and `core/shared`. It receives ports —
it never constructs an adapter, never builds a command string, never touches
`process.env`, the filesystem, or a socket.

Architecture: [`docs/architecture/deployment-engine.md`](../../../docs/architecture/deployment-engine.md).
Flow: [`docs/architecture/deployment-flow.md`](../../../docs/architecture/deployment-flow.md).
