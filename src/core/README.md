# `core/` — Domain & application logic

Framework-agnostic business logic. **Nothing here may import React, Next.js, or
any I/O library.** This is the innermost layer of the architecture and must stay
pure and dependency-light so it remains testable in isolation and portable.

Suggested structure as the product grows:

- `core/domain/` — entities, value objects, and domain rules (e.g. an
  `Application`, a `Deployment`, their invariants and state transitions).
- `core/application/` — use cases / services that orchestrate domain objects,
  depending only on **ports** (interfaces), never on concrete infrastructure.
- `core/ports/` — interfaces that outer layers implement (e.g.
  `DeploymentRepository`, `ContainerRuntime`).

Dependency rule: `core` depends on nothing else in `src/`. `server/` and
`features/` depend on `core` — never the reverse.
