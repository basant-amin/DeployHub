# DeployHub

Self-hosted deployment for Docker applications: the manual SSH deployment —
`git pull`, `docker build`, `docker stop`, `docker rm`, `docker run` — behind a web
interface, so it does not depend on one person with a terminal.

It runs on the server it deploys to, drives the host's Docker daemon directly, and
requires no change to how that server is already set up. The host's reverse proxy
keeps pointing at a fixed port and is never reconfigured. See
[Docker](./docs/docker.md) for how DeployHub itself is deployed.

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
| [Docker](./docs/docker.md)                                    | How DeployHub itself is built, run, upgraded, and secured    |

Release 1 targets **one server and one project** (One Community). Deployment is
stop-then-run against a fixed port — not zero-downtime, deliberately, so that no
control over the host's reverse proxy is required
([D12](./docs/architecture/decisions.md#d12--classic-replacement-stop-remove-run)).
Kubernetes, Swarm, multi-region, and cloud provider APIs are out of scope; the ports
they would attach to are identified in the overview.

## Requirements

- **Node.js 24 LTS** (see [`.nvmrc`](./.nvmrc); run `nvm use`)
- **npm 11+** (bundled with Node 24)

## Getting started

```bash
nvm use              # switch to Node 24
npm install
npm run dev          # http://localhost:3000
```

`npm run dev` is a first-class mode and needs no manual setup: `predev` runs
[`npm run dev:prepare`](./scripts/dev-prepare.ts), which creates a
developer-owned runtime root at `~/.deployhub-dev` — the SQLite database, the
project workspaces, and a `0600` `secrets.json` — and writes a `.env.local`
recording that path with a generated local password. It needs no `sudo`, touches
nothing under `/var`, and is idempotent, so re-running it changes nothing.

**Do not run `docs/ops/install.sh` on a development machine.** It prepares a
server's `/var/lib/deployhub` and assigns it to uid 1000, which is not your uid;
the startup check would then refuse to boot on an unreadable secrets file.

DeployHub validates the host before serving — data root and workspace writable,
`secrets.json` present at `0600` and owned by this uid, Docker socket reachable —
in the dev server and in the production containers alike
([`src/server/runtime/startup-check.ts`](./src/server/runtime/startup-check.ts)).
It exits rather than start into a state that will fail at the first deployment,
and the same check running locally is what makes it trustworthy in production.
Every problem it reports carries the command that fixes it.

`.env.local` is git-ignored and excluded from the Docker build context.
[`.env.example`](./.env.example) documents every variable; production reads
`/etc/deployhub/deployhub.env` on the server instead, and is not configured from
this repository.

## Scripts

| Script                | Description                                                                        |
| --------------------- | ---------------------------------------------------------------------------------- |
| `npm run dev`         | Start the Next.js dev server                                                       |
| `npm run dev:prepare` | Prepare the local runtime root and `.env.local` (runs automatically before `dev`)  |
| `npm run git:keygen`  | Generate a repository deploy key into the secret store; prints only the public key |
| `npm run build`       | Production build                                                                   |
| `npm run start`       | Serve the production build                                                         |
| `npm run lint`        | ESLint (flat config)                                                               |
| `npm run typecheck`   | `tsc --noEmit` (strict)                                                            |
| `npm run test`        | Run the Vitest suite once                                                          |
| `npm run test:watch`  | Vitest in watch mode                                                               |
| `npm run format`      | Format the repo with Prettier                                                      |

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
