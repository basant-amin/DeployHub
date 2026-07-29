# DeployHub architecture

DeployHub is an internal, self-hosted deployment platform. The first release
deploys **one project (One Community) to one Linux server running Docker**.

These documents define the internal architecture that the deployment engine will
be built on. Nothing here is implemented yet — this is the contract that
implementation must satisfy.

| Document                                         | Contents                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| [`deployment-flow.md`](./deployment-flow.md)     | The end-to-end flow from _Deploy_ click to _completed_, step by step      |
| [`deployment-engine.md`](./deployment-engine.md) | Lifecycle, states, lock mechanism, failure handling, recovery             |
| [`modules.md`](./modules.md)                     | Every module: purpose, responsibilities, what it owns, what it may not do |
| [`decisions.md`](./decisions.md)                 | Architectural decisions, with the alternatives that were rejected         |

## Scope boundary for release 1

**In scope:** one server, one project, one container per project, Docker as the
container runtime, a reverse proxy in front of it, Git as the source of truth,
SSH as the transport.

**Deliberately out of scope:** Kubernetes, Swarm, multi-region, cloud provider
APIs, multi-tenancy, autoscaling, build caching services, canary/percentage
traffic splitting.

Out-of-scope items are not designed for, but the seams they would attach to are
identified in [Extension points](#extension-points) below. The rule is: **absorb
future capability by adding an adapter, never by editing the engine.**

## Layering

The foundation already commits to a ports-and-adapters (hexagonal) layering with
an inward-pointing dependency rule. Phase 3 keeps that layering and expresses
"modules" as **bounded contexts inside the layers** rather than as a competing
`src/modules/` tree. The reasoning is in
[`decisions.md` § D1](./decisions.md#d1--modules-live-inside-the-existing-layers).

```
            ┌──────────────────────────────────────────────┐
  inbound   │  app/  ·  features/                          │  UI + routing
            ├──────────────────────────────────────────────┤
            │  server/runtime/    (worker, queue, wiring)  │  process hosting
            │  server/adapters/   (ssh, git, docker, …)    │  I/O
            ├──────────────────────────────────────────────┤
            │  core/application/  (engine + use cases)     │  orchestration
            │  core/ports/        (interfaces)             │  the seam
            │  core/domain/       (entities + rules)       │  pure rules
            │  core/shared/       (kernel: Result, ids)    │
            └──────────────────────────────────────────────┘
```

Dependency rule, enforced by review and (later) an ESLint import boundary rule:

- `core/domain` depends on `core/shared` only.
- `core/application` depends on `core/domain`, `core/ports`, `core/shared`.
- `core/ports` depends on `core/domain` types only (interfaces, no logic).
- `server/*` depends on `core/*` and implements `core/ports`.
- `features/*` and `app/*` depend on `core/application` use cases; **never** on
  `server/adapters` directly.
- Nothing in `core/` imports React, Next.js, `node:child_process`, a database
  client, or an SSH library.

## Proposed folder structure

Directories marked `(new)` are created in this phase as documented placeholders.
Directories marked `(planned)` are named here so the shape is agreed, and are
created by the phase that first needs them.

```
docs/
  architecture/                     (new) this design set

src/
  app/                              Next.js App Router — thin routing + shell
  components/
    ui/                             shadcn/ui primitives (generated)
  features/                         vertical UI slices
    projects/                       (planned) project screens
    deployments/                    (planned) deploy button, timeline, log viewer

  core/                             framework-agnostic; no I/O, no React
    shared/                         (new) domain kernel
      result.ts                     (planned) Result<T, E> — no thrown control flow
      errors.ts                     (planned) DeploymentError taxonomy + codes
      ids.ts                        (planned) branded ProjectId, DeploymentId, ReleaseId
      time.ts                       (planned) Duration, Timestamp value objects
      redaction.ts                  (planned) secret redaction for log lines
    domain/                         (new) entities, value objects, invariants
      projects/                     (planned) Project, DeployConfig, HealthCheckSpec
      deployments/                  (planned) Deployment aggregate, state machine, Release
    ports/                          (new) interfaces implemented by server/
      command-runner.ts             (planned) run a process somewhere (local or SSH)
      git-client.ts                 (planned) fetch / checkout / resolve ref → sha
      container-runtime.ts          (planned) build, run, rename, stop, remove, inspect
      reverse-proxy.ts              (planned) point public route at a container
      health-probe.ts               (planned) single HTTP probe attempt
      deploy-lock.ts                (planned) leased, fenced, single-writer lock
      log-sink.ts                   (planned) append + stream deployment log lines
      event-publisher.ts            (planned) status/step events for UI + notifications
      repositories.ts               (planned) Project / Deployment / Release persistence
      secret-provider.ts            (planned) resolve credentials by reference
      clock.ts                      (planned) now(), sleep() — no direct Date.now()
      id-generator.ts               (planned) id + port allocation
    application/                    (new) orchestration
      engine/                       (planned) the deployment pipeline (see below)
      use-cases/                    (planned) RequestDeployment, CancelDeployment, …
      policies/                     (planned) health policy, retention, retry, rollback

  server/                           server-only infrastructure
    adapters/                       (new) concrete port implementations
      ssh/                          (planned) CommandRunner over SSH
      local/                        (planned) CommandRunner over child_process
      git/                          (planned) GitClient built on CommandRunner
      docker/                       (planned) ContainerRuntime built on CommandRunner
      proxy/                        (planned) ReverseProxy built on CommandRunner
      health/                       (planned) HealthProbe over fetch
      logs/                         (planned) LogSink (append-only file + stream)
      lock/                         (planned) DeployLock (DB lease + remote flock)
      persistence/                  (planned) repositories
    runtime/                        (new) process hosting
      composition.ts                (planned) composition root — the only place adapters are chosen
      worker.ts                     (planned) single-writer deployment worker loop
      reconciler.ts                 (planned) boot-time recovery of interrupted deploys
      heartbeat.ts                  (planned) lock lease renewal

  lib/                              cross-cutting utilities (cn, formatting)
  config/                           env validation + typed configuration
```

## Extension points

Each future capability attaches at exactly one named seam. This is what "modular
so those features can be added later" means concretely.

| Future capability                | Attaches at                                                         | Engine change |
| -------------------------------- | ------------------------------------------------------------------- | ------------- |
| Multiple servers                 | `CommandRunner` — one instance per host; `ProjectId → host` map     | none          |
| Kubernetes / Swarm               | new `ContainerRuntime` + `ReverseProxy` adapter                     | none          |
| Traefik / Caddy instead of nginx | new `ReverseProxy` adapter                                          | none          |
| Registry-based builds            | new `ContainerRuntime.push/pull`; build step becomes build+push     | one step      |
| More projects                    | already supported — lock and queue are keyed by `ProjectId`         | none          |
| GitHub webhook triggers          | new inbound caller of the `RequestDeployment` use case              | none          |
| Notifications (Slack, email)     | new `EventPublisher` subscriber                                     | none          |
| Canary / percentage traffic      | `ReverseProxy` gains a weighted-upstream method; new promote policy | one step      |
| Authentication                   | inbound layer (`app/`, `features/`) — never reaches `core/`         | none          |
