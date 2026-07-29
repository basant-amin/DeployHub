# `server/` — Infrastructure & adapters (server-only)

Concrete implementations of the **ports** defined in `core/`: database access,
external APIs, the Docker/container runtime, message queues, etc. Code here is
server-only and must never be imported into client components.

Guidelines:

- Implement `core/ports/*` interfaces so use cases stay decoupled from vendors.
- Keep framework/runtime concerns (env, clients, connection pools) here, wired
  through `src/config`.
- Mark modules that must not reach the client with `import "server-only"`.

Depends on `core/`. Never imported by `core/`.
