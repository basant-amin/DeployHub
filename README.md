# DeployHub

Self-hosted deployment platform for Docker applications.

> This repository currently contains the **production-ready project foundation
> only** — tooling, configuration, architecture skeleton, and quality gates.
> No deployment, container, auth, or dashboard features are implemented yet.

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
src/
  app/          # Next.js App Router (routing + UI shell)
  components/    # Shared React components
    ui/          # shadcn/ui primitives (generated)
  features/      # Vertical feature slices (see features/README.md)
  core/          # Framework-agnostic domain + application logic
  server/        # Infrastructure & adapters (server-only)
  lib/           # Cross-cutting utilities (e.g. cn)
  config/        # Configuration + environment validation
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
