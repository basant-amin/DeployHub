# DeployHub — Project State

**Internal engineering memory. Not user documentation.**

This file exists so that any future session can open this repository and know, without re-reading the
codebase, where development stopped and what to do next. It is maintained continuously: whenever a
milestone completes, the [Session Notes](#session-notes) section gains an entry and the sections above
it are corrected. If something here contradicts the code, **the code is right and this file is stale** —
fix it.

Last updated: **2026-07-30** · Last commit: `49d6908` · Branch: `phase-3-deploy-architecture`

---

## Project Overview

DeployHub is an **internal deployment platform** built to make deploying the team's applications
simple. It replaces the manual routine of SSH-ing into a server, pulling a branch, rebuilding an
image, restarting a container, and hoping the result is healthy — with one button that does all of it,
verifies the result, and reverses itself if the result is bad.

It is not a product for sale and not a demo. It runs on our own server and deploys our own code, and
it is built to the standard we would want from a tool we depend on during an incident.

### Main goals

- **Deploy directly from GitHub** — a repository URL and a ref are the whole input.
- **Docker-based deployments** — the unit of deployment is an image built from the repo's Dockerfile.
- **Simple UI for developers** — one screen answers "is production okay?", one button ships.
- **Rollback support** — returning to the previous release is one click and names its destination.
- **Deployment history** — every attempt is recorded with its outcome, duration, and log.
- **Logs** — captured per step, readable during and after the deployment.
- **Minimal server management** — no Kubernetes, no orchestrator to operate, no YAML to write.
- **Future multi-project support** — release 1 is deliberately one project; nothing in the domain
  assumes that, and the seams are documented below.

### First target application

**One Community**, deployed to staging first. Not yet attempted — see
[Current Development Phase](#current-development-phase).

---

## Current Architecture

Hexagonal (ports and adapters), with a strict inward dependency rule: `core` depends on nothing
outside itself, `server` depends on `core`, and the UI depends on `core`'s read models. The full
reasoning lives in `docs/architecture/` — this is the map.

```
src/
  core/                  no I/O, no framework, no Node APIs
    shared/              the kernel: Result, error catalogue, branded value objects, redaction
    domain/              Project and Deployment aggregates, the state machine, invariants
    ports/               13 interfaces, written in the engine's language
    application/         the engine, 4 use cases, policies, read models
  server/                server-only infrastructure
    adapters/            the concrete implementations of the ports
    runtime/             composition root, worker, boot sweep, per-process platform cache
  app/                   Next.js App Router — the dashboard
  features/              screen-level composition (deployments, projects)
  components/, lib/      design system and formatting
scripts/deployhub.ts     the CLI
```

### Domain (`src/core/domain`) — frozen

Two aggregates. `Project` is identity plus `DeployConfig` plus an on/off switch, and holds no
deployment history. `Deployment` is a **16-state machine** — acyclic, 5 terminal states — where every
transition is guarded, so an illegal transition is unreachable through the public API rather than
merely discouraged.

Six invariants are enforced in the aggregate. The two that matter most:

- **Invariant 1** — at most one non-terminal deployment per project.
- **Invariant 4** — _health before promotion, route before success_. No deployment reports
  `outcome: deployed`, by the normal path or by reconciliation, without recorded verification through
  its public route. This is stronger than the original architecture document and was tightened during
  Phase 4A, because without it a worker killed mid-promotion could be reconciled into a `Release` that
  was never confirmed reachable — and a rollback would then have an unverified target.

`Deployment.rehydrate()` reconstructs an aggregate from a snapshot without replaying transitions,
which is what lets persistence store JSON and still hand back a valid aggregate.

### Shared kernel (`src/core/shared`) — frozen

`Result<T, E>` instead of thrown control flow; the domain never throws for a failure it anticipated. A
closed catalogue of **67 error codes**, each with exactly one producer. Branded value objects for every
identifier, timestamp, duration, git ref, image reference, route, and path, so passing a `DeploymentId`
where a `ProjectId` belongs is a compile error.

`redaction.ts` scrubs secrets from log lines and command output. It handles quoted multi-word values
and is idempotent — `token:[REDACTED][REDACTED]` is evidence the redactor ran twice and no evidence at
all about what it removed. Its regexes bound the _scheme_, not the credential, which is what keeps
matching linear on a 40k-character line.

### Ports (`src/core/ports`) — frozen

13 interfaces: `Clock`, `IdGenerator`, `ProjectRepository`, `DeploymentRepository`,
`ReleaseRepository`, `DeployLock`, `GitClient`, `ContainerRuntime`, `ReverseProxy`, `HealthProbe`,
`DeploymentLogSink`, `EventPublisher`, `SecretProvider`. None mentions Docker, SSH, Caddy, SQLite, or
Next.

Two deliberate omissions, both recorded in `docs/architecture/modules.md`:

- **`CommandRunner` is not a port.** "Run a process on a host" is a transport the git, container, and
  proxy adapters share, and the application layer never calls it. Declaring it at this boundary would
  invert a dependency that does not cross the layer.
- **Port allocation is not a port.** Only the host knows which ports are free, so
  `ContainerRuntime.startContainer` reports the address it actually bound rather than being told one.

### Application layer (`src/core/application`)

**Deployment Engine** (`engine/deployment-engine.ts`, ~825 lines) is written as a straight line in the
order of the flow document: validate → preflight → acquire lease → capture baseline → fetch → build →
start candidate → health check → promote → verify public route → finalize.

`run(queued)` enters `validating` before anything else, because `fail()` is illegal from `queued` and a
preflight failure has to be reportable.

**Zero downtime** comes from candidate-then-promote (D8): the old container keeps serving until the new
one has passed its own health check _and_ the route switch has been verified. Two compensations, chosen
by how far the deployment got — before promotion the candidate is discarded; after promotion the
baseline is redeployed, which is an ordinary deployment of an older sha rather than a second code path
nobody exercises until an incident.

**Use cases:** `RequestDeployment` (admission — refuses a busy project rather than queueing, per D6),
`RequestRollback`, `GetDeploymentHistory`, `GetDeploymentDetail`.

**Policies** are pure functions, so health thresholds and retention rules are tunable without touching
the pipeline.

### Infrastructure (`src/server/adapters`)

Every external command was verified against a real Docker daemon (29.1.2), a real Caddy (2.11.4), and
real git (2.46.1) **before** the adapter was written. `docs/ops/host-spike.md` records the exact forms.

- **Docker runtime** — structured state is read only via `docker inspect --format '{{json .}}'`; `ps`
  output is never parsed. A locally built image has no `RepoDigests`, so the recorded digest is the
  image `.Id`. Candidates publish on `-p 127.0.0.1::<port>`, so a candidate is unreachable from
  outside until the proxy is pointed at it. Containers are named `<slug>-<deploymentId>` for life —
  renaming was dropped because it cannot be made collision-free.
- **Caddy** — driven entirely through the admin API using `@id` addressing. No config templating, no
  reload. `fetch` sends an empty `Origin` where curl sends none, which Caddy rejects with 403, so the
  adapter sends `Origin: <adminUrl>`.
- **Git** — `CommandGitClient` over the shared `LocalCommandRunner`; credentials arrive via env, never
  argv.
- **SQLite** (`node:sqlite`) — a JSON snapshot plus extracted indexed columns, rehydrated through
  `Deployment.rehydrate()`. A **partial unique index enforces invariant 1 in the database**, so the
  admission check explains a refusal while the constraint is what makes it correct under a race.
- **Log sink** — append-only rows, opened with a redactor.
- **Secret provider** — a single local JSON file that the adapter refuses to read unless it is mode
  `0600`. **Read-only by design**: there is no write path, which is why the dashboard collects secret
  _references_ and never secret values.
- **Deploy lock** — a leased, fenced lock (`LockEpoch`), not a mutex, so a dead worker's grip expires.

### Runtime (`src/server/runtime`)

`composition.ts` is the **only** place a concrete adapter is named — swapping SQLite for Postgres or
Caddy for Traefik is an edit to that one file. `platform.ts` caches the wired platform per process
behind a `Symbol.for` key so Next's module reloading cannot produce two databases.

`boot-sweep.ts` recovers what a dead worker left behind. It must run **first** in a process's
lifecycle: running it after admission let a stranded deployment refuse the very command that would have
cleaned it up.

### Worker

`Worker` polls `findQueued(1)` and runs one deployment at a time to a terminal state. It lives in its
own process rather than inside the web server, because a deployment takes minutes and must outlive the
request that triggered it.

> ⚠️ **Known gap.** The only construction of `Worker` in the repository is inside
> `scripts/deployhub.ts`, with `maxDeployments: 1` — it runs one deployment and exits. **There is no
> long-running worker entrypoint and no service unit.** This is a blocker for operating the platform:
> the dashboard's Deploy button queues a deployment that nothing will pick up. See
> [Next Development Plan](#next-development-plan).

### Dashboard (`src/app`, `src/features`, `src/components`)

Next.js 16 App Router, React 19, Tailwind v4. **Server Components by default**; the only client
components are the ones where interaction is the point — the palette, the forms, the copy buttons, the
log scroll pane, the polling component, and the nav links.

Screens: `/` (production), `/deployments` (history, URL-based filters), `/deployments/[id]` (detail),
`/setup`, `/settings`, `/signin`. All `force-dynamic` — a dashboard whose home page is cached is a
dashboard that lies.

Design decisions worth not re-litigating:

- `components/ui/status.tsx` is the **sole owner** of "state → colour, label, glyph". Colour never
  carries meaning alone; every status has a distinct glyph and an explicit word.
- `no_change` is not "Succeeded". Nothing shipped, and calling it success erodes the word everywhere.
- The **blast-radius callout** leads with impact, then cause, then action. A failure that never reached
  promotion says so: _production was not affected_.
- While a deployment runs, the hero states that **the previous release is still live and serving
  traffic** — true up to promotion, and the most reassuring fact available to someone watching a build.
- The **step rail is derived from the transition timeline**, not from stored step records, so there is
  one source of timing and it works retroactively.
- No progress bar and no percentage. A build of 48s and a promote of 0.4s cannot be honestly summarised
  by one number.

### Authentication

One shared password in `DEPLOYHUB_PASSWORD` (minimum 8 characters) and a cookie holding an
HMAC-SHA256 derived from it via Web Crypto. No user records, no session store. **A leaked cookie is
exactly as bad as a leaked password** — worth stating rather than hiding.

`src/proxy.ts` (Next 16 renamed the `middleware` convention to `proxy`) gates all navigation, and
**every mutating server action re-checks the session**, because a server action is a separately
addressable endpoint. With no password set the dashboard fails closed: every route redirects to
`/signin`, which explains what to set.

### Settings and project registration

One data-driven form used by both `/setup` and `/settings`. Every input's `name` **is the domain's
dotted path** into `ProjectInput`, which is what lets the server rebuild the nested object, the prefill
flatten a saved project, and a validation issue land on the right input — with no translation table to
drift. Four fields are genuinely required (name, repository URL, container port, route host); the slug
and the three references derive from them.

The slug is read-only after creation, in the form **and** in the action: it is embedded in container
names, image repositories, and the workspace path, so changing it would orphan everything on the
server rather than rename it.

There is no delete. A project is taken out of service by **pausing**, which keeps its configuration and
its history.

### Live polling

`router.refresh()` on a schedule — not a fetch layer. The server re-renders and streams new HTML into
the existing tree, so there is no client cache, no API route, and no way for polled data to disagree
with rendered data. That is why the screens stayed Server Components.

One second while something is happening; **stop entirely** on a terminal state; **skip** the request
while the tab is hidden; **refresh immediately** when it returns; **back off** to three seconds after
two minutes without new output.

`isLive()` is deliberately _not_ the domain's `isActive`: `queued` is pending yet is exactly when
someone is waiting, and `interrupted` is active yet cannot change without another deployment.

### Logs

Captured per step and grouped by step, with exactly one group open — the running step, then the failed
step, then the longest. A four-thousand-line undifferentiated scrollback is a fallback, not a default,
so the **Raw log sheet** exists as an escape hatch and is not the front door. **Copy diagnostics**
turns the whole deployment into pasteable text, because the artefact an incident produces is a message
in a channel, not a screenshot.

### Rollback

There is no rollback pipeline (D5). `RequestRollback` resolves a target release and queues an ordinary
deployment whose target ref is that release's commit sha, so a rollback is validated, locked,
health-checked, and route-verified like anything else. Its confirmation dialog is a fact sheet — what it
returns to, when that shipped, what it replaces — and the control is withheld entirely when the domain
would refuse it (paused project, or a deployment already in flight).

---

## MVP Status

**The MVP is essentially complete.** The platform performs real zero-downtime deployments with
automatic rollback, and the dashboard covers every screen needed to operate it.

### Completed

| Area                                                                         | State                         |
| ---------------------------------------------------------------------------- | ----------------------------- |
| Core domain (aggregates, 16-state machine, invariants)                       | ✅ frozen                     |
| Shared kernel (Result, 67 error codes, value objects, redaction)             | ✅ frozen                     |
| Ports (13 interfaces)                                                        | ✅ frozen                     |
| Deployment engine (candidate-then-promote, both compensations)               | ✅                            |
| Infrastructure adapters (Docker, git, Caddy, SQLite, secrets, lock, logs)    | ✅                            |
| SQLite persistence (snapshot + indexed columns, invariant 1 as a constraint) | ✅                            |
| Worker (one-at-a-time loop, boot sweep)                                      | ⚠️ no long-running entrypoint |
| Dashboard — production, history, detail                                      | ✅                            |
| Authentication (shared password, fails closed)                               | ✅                            |
| Project registration and settings                                            | ✅                            |
| Live deployment updates (adaptive polling)                                   | ✅                            |
| Deploy and rollback from the UI, with optimistic state                       | ✅                            |
| Keyboard shortcuts and ⌘K command palette                                    | ✅                            |
| Accessibility (contrast floor, landmarks, labels, skip link, `aria-current`) | ✅                            |
| Light theme (cookie-backed, no flash)                                        | ✅                            |
| Diagnostics (copy as text)                                                   | ✅                            |
| Raw logs (sheet + copy)                                                      | ✅                            |
| Tests                                                                        | ✅                            |

### Test count

**416 tests across 23 files**, all passing. Quality gate is four commands, all green:

```
npm run lint && npm run typecheck && npm run test && npm run build
```

Notable coverage: the deployment engine's full pipeline and both compensations in-memory; the redaction
rules including the quadratic-regex regression; the form's validation-issue attribution driven through
the _real_ domain for all 19 fields; and the design system's contrast floor parsed out of the
stylesheet so it cannot silently regress.

### Latest completed milestone

**Phase 5B, Increment 6** — keyboard layer, light theme, diagnostics, raw log sheet, accessibility
pass. Commit `49d6908`.

### Proven by real execution (macOS host)

Real clone from GitHub, real `docker build`, real containers, real Caddy switches, real HTTP probes:

- A successful deployment triggered from the browser: **4.8s**, both trust checks green.
- **Zero downtime measured** across a promotion: 117 requests during the switch, **all HTTP 200**
  (23 served by the old container, 94 by the new one).
- Automatic rollback: previous release restored, deployment marked `rolled_back`, **263 requests all
  200**.
- `no_change` short circuit, manual rollback, and a boot sweep recovering 1 stranded deployment, 1
  lease, and 1 container.

---

## Current Development Phase

**Development has intentionally paused before Linux deployment.**

Everything so far was built and verified on **macOS**. That was the right way to get here quickly, and
it is explicitly not the same as working on the target platform. The next phase is therefore not new
features.

### Current phase: Real Linux validation

The goal is to prove the platform operates on Ubuntu, fix what differs, and then deploy One Community
to staging as the first real application.

**Do not start new features until this phase is finished.** Adding multi-project support on top of a
platform that has never run on its target OS would mean debugging two unknowns at once.

### Known Linux-specific risks

1. **`df -Pk` column order** — marked `[verify on Linux]` in `docs/ops/host-spike.md`. Preflight's
   free-space check parses total from column 2 and available from column 4. macOS and GNU coreutils
   agree under `-P`, but the column _order_ needs confirming on the target. If it differs, preflight
   will either refuse a healthy server or fail to catch a full disk.
2. **The long-running worker** — see the gap noted under [Worker](#worker). This must be built before
   the dashboard can deploy anything on the server.
3. **Docker socket permissions** — the DeployHub process needs to reach `/var/run/docker.sock`. That
   means a group membership decision, and it is a privilege boundary worth thinking about rather than
   solving with `sudo`.
4. **Caddy admin API reachability** — the adapter assumes `http://localhost:2019`, which is Caddy's
   default and should be kept bound to loopback.

---

## Production Test Environment

A VPS has been purchased specifically for Linux validation.

|              |                  |
| ------------ | ---------------- |
| **Provider** | IONOS            |
| **OS**       | Ubuntu 24.04 LTS |
| **vCPU**     | 6                |
| **RAM**      | 8 GB             |
| **Storage**  | 240 GB NVMe      |

### Purpose

**Primary Linux validation server for DeployHub.** Intended for:

- Docker validation
- Worker validation
- Real deployment testing
- Rollback verification
- Linux readiness
- One Community **staging** deployment

### Status

Not yet provisioned. No connection details are recorded in this repository — and none should be.
Hostnames, IP addresses, usernames, SSH keys, and passwords belong in the team's secret store, never in
a file that is committed. This document tracks _what has been done_, not _how to get in_.

---

## Next Development Plan

Follow this order. Steps 1–11 harden the server before anything of ours is on it; the ordering is not
arbitrary and skipping ahead is how a box ends up exposed.

### Server provisioning

1. **First login to the VPS.**
2. **Update Ubuntu** — `apt update && apt full-upgrade`, then reboot if the kernel changed.
3. **Create a non-root sudo user.**
4. **Configure SSH keys** for that user.
5. **Disable password authentication** — _only after confirming key login works in a second, separate
   session._ Locking yourself out of a fresh VPS is the classic way to lose an afternoon.
6. **Secure the SSH configuration** — no root login, no password auth, key types explicit.
7. **Configure the firewall** — default deny inbound; allow SSH, 80, and 443. **Do not expose 2019
   (Caddy admin) or the dashboard port.**
8. **Install Git.**
9. **Install Docker** — from Docker's own apt repository, not the distro package.
10. **Install Docker Compose** if required. _(DeployHub itself does not use it; the applications being
    deployed may.)_
11. **Verify Docker** — `docker run --rm hello-world` as the non-root user, which also proves the group
    membership from step 9.

### DeployHub setup

12. **Clone DeployHub.**
13. **Configure the environment** — see [Environment](#environment) below, and create the secrets file
    at mode `0600`.
14. **Execute Linux Readiness validation** — work through `docs/ops/host-spike.md` command by command
    against this host, and resolve every `[verify on Linux]` marker.
15. **Fix Linux-specific issues** — expect `df -Pk` parsing and Docker socket permissions first.

### Platform validation

16. **Validate Deploy** — a real deployment end to end, then confirm zero downtime under load as was
    measured on macOS.
17. **Validate Rollback** — including the automatic path, by deliberately failing a health check.
18. **Validate Logs** — captured per step, complete, and with secrets redacted.
19. **Validate Worker** — **this requires building the long-running worker entrypoint first.**
    Concretely: an entrypoint that constructs the platform and runs `Worker` with no `maxDeployments`, a
    `worker` npm script, and a systemd unit with `Restart=always`. Then verify that the boot sweep
    recovers correctly when the service is killed mid-deployment.
20. **Deploy One Community Staging** as the first real application.

### Engineering work implied by the above

These are code changes, not server steps, and they block step 19 and step 20:

- **Long-running worker entrypoint + systemd unit** (blocks 19 and 20).
- **`df -Pk` parsing confirmed or corrected** (blocks 16).
- A **deployment guide** in `docs/ops/` recording what was actually done to this server, so the next
  server does not require rediscovery.

---

## Future Roadmap

After Linux validation and the One Community staging deployment. Roughly in the order the seams already
support:

- **Multi-project management** — the domain never assumed one project. The known work: the UI resolves
  "the project" as `projects[0]` in `features/deployments/data.ts` and in the server actions, and the
  top bar's project name becomes a picker. `loadProduction`/`loadHistory` gain a slug parameter.
- **Team permissions** — replaces the shared password. `Actor` already exists as an audit field and is
  deliberately _not_ an authorization one; permission is settled at the inbound boundary.
- **GitHub App integration** — deploy on push, commit status checks, and a real commit _subject_ on
  every row (see [Known deferrals](#known-deferrals)).
- **Multi-server support** — D3 already treats SSH as a transport the tool adapters compose, so this is
  an adapter change rather than an architecture change.
- **Secrets management** — a write path, and something better than one JSON file.
- **Notifications** — the `EventPublisher` port exists and is currently unused for this reason.
- **Health monitoring** — continuous, as opposed to the at-deploy probes that exist now.
- **Automatic backups** — of the SQLite database and the secrets file.
- **Production deployments** — after staging has been trusted for a while.

Explicitly **not** planned: Kubernetes, Docker Swarm, multi-region, canary deployments, a plugin
system, a YAML pipeline editor, or an analytics dashboard.

---

## Important Architectural Decisions

Decisions that should not be re-argued without a reason. The numbered ones are documented in full with
their alternatives and consequences in `docs/architecture/decisions.md`.

### Standing constraints

- **SQLite remains the MVP database.** One file, no server to operate, and the schema is a snapshot
  plus indexed columns. The seam for changing it is `composition.ts` and nothing else.
- **Docker is the deployment runtime.** Structured state comes from `docker inspect`; `ps` output is
  never parsed.
- **Caddy is the reverse proxy**, driven through its admin API with `@id` addressing. No config
  templating, no reload.
- **GitHub is the deployment source.**
- **Keep the architecture modular.** The inward dependency rule is the point: `core` must stay free of
  I/O, frameworks, and Node APIs, and only `composition.ts` may name an adapter.
- **Avoid unnecessary complexity.** Features were removed during development for being speculative;
  that was correct. No port, abstraction, or configuration field exists without a caller.
- **Build production-grade software, not a demo.** No TODOs, no placeholders, no mock implementations
  in shipped code. Every external command was verified against a real host before its adapter was
  written.

### Numbered decisions (`docs/architecture/decisions.md`)

|     | Decision                                                                |
| --- | ----------------------------------------------------------------------- |
| D1  | Modules live inside the existing layers                                 |
| D2  | The engine is a declarative step pipeline, not imperative orchestration |
| D3  | SSH is a transport, not a capability module                             |
| D4  | Deployments are identified by immutable commit sha and image digest     |
| D5  | Rollback is a deployment, not a separate mechanism                      |
| D6  | Reject concurrent deploys rather than queue them                        |
| D7  | The engine runs in a long-lived worker, not a request handler           |
| D8  | Candidate-then-promote, not stop-then-start                             |
| D9  | Health checks are policy in core, probes are adapters                   |
| D10 | Two health checks, before and after promotion                           |
| D11 | The reconciler exists in release 1                                      |

### UI decisions worth preserving

- **Server Components by default.** Client components only where interaction is the point.
- **Polling is `router.refresh()`**, not a fetch layer, so there is only one copy of the data.
- **One owner of status appearance** (`components/ui/status.tsx`). Colour never carries meaning alone.
- **Deploy is unconfirmed; rollback is confirmed with a fact sheet.** A dialog in front of the primary
  action trains people to dismiss dialogs, which is the habit you least want when the rollback dialog
  appears.
- **Every text token clears 4.5:1 on every surface in both themes**, enforced by
  `src/app/contrast.test.ts` parsing the stylesheet. The first pass shipped `--ink-3` at 2.94:1; it
  looked fine and only measuring found it.
- **Prefetching is off** (`components/ui/link.tsx`, enforced by an ESLint rule). Every route is
  `force-dynamic`, so a prefetch cannot produce a reusable payload — and while a page polls it
  multiplied one request per second into three.

### Environment

Read by `runtimeConfigFromEnv()` in `src/server/runtime/composition.ts`, plus two the dashboard reads
directly. Defaults in parentheses.

| Variable                  | Purpose                                                         |
| ------------------------- | --------------------------------------------------------------- |
| `DEPLOYHUB_ROOT`          | Base directory (`/var/lib/deployhub`)                           |
| `DEPLOYHUB_DATABASE`      | SQLite file (`<root>/deployhub.db`)                             |
| `DEPLOYHUB_WORKSPACES`    | One git workspace per project (`<root>/projects`)               |
| `DEPLOYHUB_SECRETS`       | Secrets JSON, **mode 0600** (`<root>/secrets.json`)             |
| `DEPLOYHUB_CADDY_ADMIN`   | Caddy admin endpoint (`http://localhost:2019`)                  |
| `DEPLOYHUB_CADDY_SERVER`  | Server key inside `apps.http.servers` (`main`)                  |
| `DEPLOYHUB_BIND_HOST`     | Address candidates publish on (`127.0.0.1`)                     |
| `DEPLOYHUB_PUBLIC_SCHEME` | `http` or `https` (`https`)                                     |
| `DEPLOYHUB_PUBLIC_PORT`   | Public port Caddy serves (`443`)                                |
| `DEPLOYHUB_STORAGE_PATH`  | Filesystem preflight checks for free space (`/var/lib/docker`)  |
| `DEPLOYHUB_LEASE_TTL_MS`  | How long a deploy lease survives without a heartbeat (`60000`)  |
| `DEPLOYHUB_PASSWORD`      | Dashboard shared password, ≥8 chars. **Unset ⇒ fails closed.**  |
| `DEPLOYHUB_ACTOR`         | Actor recorded on dashboard-triggered deployments (`dashboard`) |

### Known deferrals

- **`commitSubject` on `DeploymentSummary`.** Every history row shows a sha where a commit message
  would be more human. Adding it needs either a new domain field or a new port method, and both layers
  are frozen. Best done alongside GitHub App integration.
- **`EventPublisher` is implemented but unused.** It exists for notifications and event streaming; no
  adapter subscribes yet. Intentional — a port without a caller was accepted here because D2 requires
  the engine to emit.
- **The branch name no longer describes its contents.** `phase-3-deploy-architecture` holds phases 3
  through 5B. Rename or split before opening a PR.

---

## Session Notes

Newest first. Each entry: date, what was completed, what remains, blockers, and the next immediate
task. **Add an entry after every significant milestone.**

### 2026-07-30 — Internal project state document created

**Completed.** This document. Audited the repository to write it rather than working from memory, which
surfaced the worker-entrypoint gap recorded below.

**Remaining.** The whole Linux validation phase. No code was written today.

**Blockers.**

- 🔴 **No long-running worker entrypoint.** The only `new Worker(...)` in the repository is in
  `scripts/deployhub.ts` with `maxDeployments: 1`. The dashboard's Deploy button queues a deployment
  that nothing will run. This blocks steps 19 and 20 of the next plan and must be built before the VPS
  can usefully run DeployHub. During Phase 5B verification a throwaway long-running worker was used
  from a scratch directory; it was never committed, by design — it was a test harness, not a service.
- 🟡 **`df -Pk` column order unconfirmed on Linux.** Affects preflight's free-space check.

**Next immediate task.** Step 1 of the Next Development Plan: first login to the VPS and update Ubuntu.
The worker entrypoint can be built in parallel, since it needs no server.

---

### 2026-07-29 — Phase 5B complete (dashboard, 6 increments)

**Completed.** The whole dashboard, in six increments, each with the quality gate green:

1. Design system and the production overview.
2. Deployment history and the deployment detail screen.
3. Deploy, rollback, shared-password authentication, server actions, optimistic UI.
4. Adaptive live polling, log auto-follow, auto-expanding active step.
5. `/setup`, `/settings`, the data-driven project form with per-field domain validation.
6. ⌘K palette and keyboard layer, light theme, copy diagnostics, raw log sheet, accessibility pass.

Committed as five commits (`a6e1124`, `8958493`, `3afe9d3`, `49d6908`, plus the layer commits below).
Tests grew from 303 to **416**.

**Defects found and fixed while verifying** — worth recording because each was found by _using_ the
thing, not by reading it:

- The step rail was empty: the engine never writes step records. Fixed by deriving the rail from the
  transition timeline, which is truer and works retroactively.
- `formatDuration` rendered 779.6s as `12m 60s` — it rounded each unit separately.
- `--ink-3` failed WCAG AA in both themes (2.94:1 / 2.56:1); measuring then caught four more tokens.
- Polling fetched three routes per tick, because `router.refresh()` invalidates the router cache and
  every visible link prefetches again.
- A queued deployment's header read "master on master"; `shortSha` also truncated branch names.
- Two health-check fields' validation issues landed above the form instead of under their inputs
  (`intervalMillis` is validated as `interval`).
- A success message rendered in a red callout.
- Rollback was offered on a paused project, where the domain refuses it.

**Remaining.** Linux validation.

**Blockers.** None at the time.

**Next immediate task.** Provision the VPS.

---

### 2026-07-29 — Phase 4D complete (first real deployment)

**Completed.** All infrastructure adapters and the runtime, verified against a real host before being
written. Proved the platform end to end: real clone, real build, real containers, real Caddy switches.
**Zero downtime measured** — 117 requests across a promotion, all 200. Automatic rollback verified with
263 requests all 200. Boot sweep recovered a stranded deployment, a lease, and a container.

**Findings that changed the code.** Caddy rejects `fetch`'s empty `Origin` with 403; `docker build`
needs an explicit cwd; `SystemClock.sleep` must not `unref()` its timer or the process exits mid
health-check; the boot sweep must run before admission.

**Next immediate task.** Design the dashboard (Phase 5A).

---

### 2026-07-29 — Phases 4A–4C complete (core)

**Completed.** Domain layer, ports layer, application layer. Phase 4A was reviewed critically and then
finalized, which found and fixed two blocking issues: a reconciler path that could produce an
unverified release (invariant 4 was tightened as a result), and a redaction rule that missed quoted
multi-word secrets. A quadratic regex in redaction was also found and fixed — 848ms at 40k characters,
down to 3.9ms.

**Next immediate task.** Implement the infrastructure adapters (Phase 4D).
