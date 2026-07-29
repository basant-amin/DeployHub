# DeployHub

Self-hosted deployment platform for Docker applications.

> This repository currently contains the **production-ready project foundation and
> the deployment architecture design** — tooling, configuration, layering, and
> quality gates. No deployment, container, auth, or dashboard features are
> implemented yet.

## Architecture

The internal design of the deployment engine is specified in
[`docs/architecture/`](./docs/architecture/README.md):

| Document                                                      | Contents                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------ |
| [Overview](./docs/architecture/README.md)                     | Layering, folder structure, scope boundary, extension points |
| [Deployment flow](./docs/architecture/deployment-flow.md)     | _Deploy_ click → completed, step by step                     |
| [Deployment engine](./docs/architecture/deployment-engine.md) | Lifecycle, states, lock, failure handling, recovery          |
| [Modules](./docs/architecture/modules.md)                     | Per-module purpose, responsibilities, and boundaries         |
| [Decisions](./docs/architecture/decisions.md)                 | Decisions taken, and the alternatives rejected               |

Release 1 targets **one server and one project** (One Community). Kubernetes,
Swarm, multi-region, and cloud provider APIs are out of scope; the ports they would
attach to are identified in the overview.

## Requirements

- **Node.js 24 LTS** (see [`.nvmrc`](./.nvmrc); run `nvm use`)
- **npm 11+** (bundled with Node 24)

## Getting started

```bash
nvm use              # switch to Node 24
npm install
cp .env.example .env.local   # then fill in values
npm run dev          # http://localhost:3000
```

Environment variables are validated at startup by
[`src/config/env.ts`](./src/config/env.ts); the app refuses to boot on invalid
configuration.

## Scripts

| Script               | Description                   |
| -------------------- | ----------------------------- |
| `npm run dev`        | Start the Next.js dev server  |
| `npm run build`      | Production build              |
| `npm run start`      | Serve the production build    |
| `npm run lint`       | ESLint (flat config)          |
| `npm run typecheck`  | `tsc --noEmit` (strict)       |
| `npm run test`       | Run the Vitest suite once     |
| `npm run test:watch` | Vitest in watch mode          |
| `npm run format`     | Format the repo with Prettier |

## Tech stack

Next.js 16 · React 19 · TypeScript 6 (strict) · Tailwind CSS 4 · shadcn/ui ·
ESLint 9 · Prettier 3 · Vitest 4 · Husky + lint-staged.

Exact pinned versions live in [`package.json`](./package.json).

> **Note — TypeScript:** pinned to the **6.0.x** line, not 7.0. TypeScript 7
> (the native compiler) shipped without a stable programmatic API, so
> `typescript-eslint` and other tooling cannot support it until TS 7.1. We
> migrate once that lands.

> **Note — ESLint:** pinned to the **9.x** line. `eslint-config-next@16` bundles
> plugins that still use APIs removed in ESLint 10, so it is not yet
> ESLint-10-ready. We upgrade once upstream ships compatible plugins.

## Project structure

```
docs/
  architecture/   # Deployment architecture specification
src/
  app/            # Next.js App Router (routing + UI shell)
  components/     # Shared React components
    ui/           # shadcn/ui primitives (generated)
  features/       # Vertical feature slices (see features/README.md)
  core/           # Framework-agnostic domain + application logic
    shared/       # Domain kernel: Result, errors, ids, time
    domain/       # Entities, value objects, the deployment state machine
    ports/        # Interfaces implemented by server/
    application/  # Deployment engine, use cases, policies
  server/         # Infrastructure & adapters (server-only)
    adapters/     # ssh, git, docker, proxy, health, logs, lock, persistence
    runtime/      # Composition root, worker, heartbeat, reconciler
  lib/            # Cross-cutting utilities (e.g. cn)
  config/         # Configuration + environment validation
```

The dependency rule points inward: `app`/`features`/`server` may depend on
`core`; `core` depends on nothing else in `src/`. See the `README.md` in each
layer for details.

## Quality gate

Every change must pass:

```bash
npm run lint && npm run typecheck && npm run test && npm run build && npm audit
```

Dependency vulnerabilities are resolved by selecting better versions (pinned
directly or via `overrides`), never by `npm audit fix --force`.
