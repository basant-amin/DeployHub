# `core/` — Domain & application logic

Framework-agnostic business logic. **Nothing here may import React, Next.js, or
any I/O library.** This is the innermost layer of the architecture and must stay
pure and dependency-light so it remains testable in isolation and portable.

Structure (see each subdirectory's `README.md`):

- `core/shared/` — domain kernel: `Result`, error taxonomy, branded ids, time
  primitives, redaction. Imports nothing.
- `core/domain/` — entities, value objects, and domain rules, one subdirectory per
  bounded context (`projects/`, `deployments/`). Owns the deployment state machine
  and its invariants.
- `core/ports/` — interfaces that outer layers implement (`ContainerRuntime`,
  `GitClient`, `CommandRunner`, `DeployLock`, repositories, …).
- `core/application/` — the deployment engine, use cases, and policies. Orchestrates
  domain objects through **ports** only, never concrete infrastructure.

Dependency rule: `core` depends on nothing else in `src/`. `server/` and
`features/` depend on `core` — never the reverse.

The deployment architecture this layer implements is specified in
[`docs/architecture/`](../../docs/architecture/README.md).
