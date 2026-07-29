# `server/` — Infrastructure & adapters (server-only)

Concrete implementations of the **ports** defined in `core/`: database access,
external APIs, the Docker/container runtime, message queues, etc. Code here is
server-only and must never be imported into client components.

Structure:

- `adapters/` — one directory per port implementation (`ssh`, `local`, `git`,
  `docker`, `proxy`, `health`, `logs`, `lock`, `persistence`).
- `runtime/` — process hosting: composition root, deployment worker, heartbeat,
  reconciler. No deployment logic.

Guidelines:

- Implement `core/ports/*` interfaces so use cases stay decoupled from vendors.
- Adapters carry no decision-making: they do what they are told and report what
  happened. Retry, thresholds, and rollback decisions belong in `core`.
- Concrete adapters are selected in exactly one place — `runtime/composition.ts`.
- Keep framework/runtime concerns (env, clients, connection pools) here, wired
  through `src/config`.
- Mark modules that must not reach the client with `import "server-only"`.

Depends on `core/`. Never imported by `core/`, `features/`, or `app/`.

Per-adapter boundaries are specified in
[`docs/architecture/modules.md`](../../docs/architecture/modules.md).
