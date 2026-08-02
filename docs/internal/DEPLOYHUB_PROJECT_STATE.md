# DeployHub — Project State

**Internal engineering memory. Not user documentation.**

This file exists so that any future session can open this repository and know, without re-reading the
codebase, where development stopped and what to do next. It is maintained continuously: whenever a
milestone completes, the [Session Notes](#session-notes) section gains an entry and the sections above
it are corrected. If something here contradicts the code, **the code is right and this file is stale** —
fix it.

Last updated: **2026-08-02** · Branch: `classic-deployment-strategy`

---

## Project Overview

DeployHub is an **internal deployment platform** built to make deploying the team's applications
simple. It replaces the manual routine of SSH-ing into a server, pulling a branch, rebuilding an
image, restarting a container, and hoping the result is healthy — with one button that does all of it,
verifies the result, and reverses itself if the result is bad.

It is not a product for sale and not a demo. It runs on our own server and deploys our own code, and
it is built to the standard we would want from a tool we depend on during an incident.

### Main goals

- **Replace manual SSH deployment** — this is the MVP, and the whole of it. A developer opens
  DeployHub, picks a branch, presses Deploy, and the platform runs the exact sequence an engineer
  runs by hand today. No SSH, no terminal, no Linux knowledge, and no dependence on one person.
- **Adapt to the server, not the other way round** — production already works, and DeployHub
  installs onto it without changing how anything is hosted.
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
closed catalogue of **65 error codes**, each with exactly one producer. Branded value objects for every
identifier, timestamp, duration, git ref, image reference, route, and path, so passing a `DeploymentId`
where a `ProjectId` belongs is a compile error.

`redaction.ts` scrubs secrets from log lines and command output. It handles quoted multi-word values
and is idempotent — `token:[REDACTED][REDACTED]` is evidence the redactor ran twice and no evidence at
all about what it removed. Its regexes bound the _scheme_, not the credential, which is what keeps
matching linear on a 40k-character line.

### Ports (`src/core/ports`) — frozen

12 interfaces: `Clock`, `IdGenerator`, `ProjectRepository`, `DeploymentRepository`,
`ReleaseRepository`, `DeployLock`, `GitClient`, `ContainerRuntime`, `ReverseProxy`, `HealthProbe`,
`DeploymentLogSink`, `EventPublisher`, `SecretProvider`. None mentions Docker, SSH, SQLite, or
Next.

Two deliberate omissions, both recorded in `docs/architecture/modules.md`:

- **`CommandRunner` is not a port.** "Run a process on a host" is a transport the git, container, and
  proxy adapters share, and the application layer never calls it. Declaring it at this boundary would
  invert a dependency that does not cross the layer.
- **Port allocation is not a port.** Only the host knows which ports are free, so
  `ContainerRuntime.startContainer` reports the address it actually bound rather than being told one.

### Application layer (`src/core/application`)

**Deployment Engine** (`engine/deployment-engine.ts`) is written as a straight line in the order of
the flow document: validate → preflight → acquire lease → capture baseline → fetch → build → stop
→ remove → run → health check → verify public route → finalize.

`run(queued)` enters `validating` before anything else, because `fail()` is illegal from `queued` and a
preflight failure has to be reportable.

**Classic replacement** (D12): stop the previous container, remove it, start the new one under the
same name and the same published port. Two compensations, chosen by how far the deployment got —
before the previous container is displaced a failure is an ordinary `failed`; after it, the only
honest answer is a rollback, which restarts the previous image **by digest**.

There is **no zero downtime**, deliberately. The site is down from `docker stop` until the
replacement answers. That was the cost of not requiring control over the host's reverse proxy, and
it was accepted knowingly — D8 records the design that traded the other way, for when a project
needs it.

**Use cases:** `RequestDeployment` (admission — refuses a busy project rather than queueing, per D6),
`RequestRollback`, `GetDeploymentHistory`, `GetDeploymentDetail`.

**Policies** are pure functions, so health thresholds and retention rules are tunable without touching
the pipeline.

### Infrastructure (`src/server/adapters`)

Every external command was verified against a real Docker daemon (29.1.2) and real git (2.46.1)
**before** the adapter was written. `docs/ops/host-spike.md` records the exact forms.

- **Docker runtime** — structured state is read only via `docker inspect --format '{{json .}}'`; `ps`
  output is never parsed. A locally built image has no `RepoDigests`, so the recorded digest is the
  image `.Id`. Containers publish on `-p <bindHost>:<port>:<port>` — a **fixed** port, which is what
  lets the host's proxy hold one static upstream. One container per project, named `<slug>`, so
  `docker stop one-community` still means what an operator expects.
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
Docker for another runtime is an edit to that one file. `platform.ts` caches the wired platform per process
behind a `Symbol.for` key so Next's module reloading cannot produce two databases.

`boot-sweep.ts` recovers what a dead worker left behind. It must run **first** in a process's
lifecycle: running it after admission let a stranded deployment refuse the very command that would have
cleaned it up.

### Worker

`Worker` polls `findQueued(1)` and runs one deployment at a time to a terminal state. It lives in its
own process rather than inside the web server, because a deployment takes minutes and must outlive the
request that triggered it.

`scripts/worker.ts` is the long-running entrypoint, run as its own container from the same image
(`npm run worker` locally). It finishes the deployment in flight on SIGTERM, which is why the
worker container is started with `--stop-timeout 1800`.

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
drift. Four fields are genuinely required (name, repository URL, container port, route host); the slug,
the container name, and the three references derive from them.

The slug **and the container name** are read-only after creation, in the form and in the action.
The slug is embedded in image repositories and the workspace path; the container name is what
`stop`, `rm`, `run`, and baseline capture address. Changing either would orphan what is on the
server rather than rename it — and for the container name it would then collide with the orphan on
the published port.

**Container name is project configuration** (`config.containerName`), not a derived value. It
defaults to the slug, which is what a new project wants, and is overridden when adopting an
application already running on the host under a name the platform did not choose. That is the
difference between DeployHub fitting onto a working server and requiring the server to be renamed
to suit it.

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

| Area                                                                         | State     |
| ---------------------------------------------------------------------------- | --------- |
| Core domain (aggregates, 16-state machine, invariants)                       | ✅ frozen |
| Shared kernel (Result, 65 error codes, value objects, redaction)             | ✅ frozen |
| Ports (12 interfaces)                                                        | ✅ frozen |
| Deployment engine (classic replacement, both compensations)                  | ✅        |
| Infrastructure adapters (Docker, git, SQLite, secrets, lock, logs)           | ✅        |
| SQLite persistence (snapshot + indexed columns, invariant 1 as a constraint) | ✅        |
| Worker (one-at-a-time loop, boot sweep, long-running entrypoint)             | ✅        |
| Dashboard — production, history, detail                                      | ✅        |
| Authentication (shared password, fails closed)                               | ✅        |
| Project registration and settings                                            | ✅        |
| Live deployment updates (adaptive polling)                                   | ✅        |
| Deploy and rollback from the UI, with optimistic state                       | ✅        |
| Keyboard shortcuts and ⌘K command palette                                    | ✅        |
| Accessibility (contrast floor, landmarks, labels, skip link, `aria-current`) | ✅        |
| Light theme (cookie-backed, no flash)                                        | ✅        |
| Diagnostics (copy as text)                                                   | ✅        |
| Raw logs (sheet + copy)                                                      | ✅        |
| Tests                                                                        | ✅        |

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

Under the superseded candidate-then-promote design. Real clone from GitHub, real `docker build`,
real containers, real Caddy switches, real HTTP probes:

- A successful deployment triggered from the browser: **4.8s**, both trust checks green.
- **Zero downtime measured** across a promotion: 117 requests during the switch, **all HTTP 200**
  (23 served by the old container, 94 by the new one).
- Automatic rollback: previous release restored, deployment marked `rolled_back`, **263 requests all
  200**.
- `no_change` short circuit, manual rollback, and a boot sweep recovering 1 stranded deployment, 1
  lease, and 1 container.

---

## Current Development Phase

**Paused mid-VPS-validation, on 2026-08-02. Both containers are running on the VPS.**

### Where things stand, exactly

DeployHub is installed and running on the Ubuntu VPS. `deployhub-web` and `deployhub-worker` are
both up, `curl http://127.0.0.1:8080/signin` returns 200, and the worker reaches the host's Docker
daemon. **Nothing has been deployed through it yet** — no project is registered and no deployment
has ever run end to end.

### The immediate next task

**Put nginx in front of the dashboard.** The config is written and validated but **not yet applied
to the server**: `docs/ops/nginx-deployhub.conf`. Procedure in `docs/docker.md` § nginx. In short:
copy to `sites-available/deployhub`, set `server_name`, symlink, `nginx -t`, `systemctl reload`.

Two things to be careful about, both recorded in the file itself:

- **Do not add `default_server`.** OneCommunity is served by the same nginx; a second default
  server on port 80 makes `nginx -t` fail and would be caught before reload — but check
  `sudo nginx -T | grep -nE "listen|server_name"` first anyway.
- **Port 80 is plain HTTP, and the dashboard password is a root credential** (the container holds
  the Docker socket). Restrict with `ufw allow from <your ip> to any port 80 proto tcp`, or skip
  nginx during validation and use `ssh -L 8080:127.0.0.1:8080`. HTTPS and Cloudflare are
  deliberately deferred until the MVP is validated.

### After nginx

1. Register OneCommunity through `/setup`. **Container name `one-community`** (the name the
   running container already uses — it is read-only after creation) and **container port 3000**.
2. First real deployment. Expect it to stop and remove the hand-started container and replace it.
   **There is no rollback target on the first run** — an unlabelled namesake is not recognised as
   a baseline, so that deployment is a first deploy. Do it when a short outage is acceptable.
3. Validate rollback by deliberately failing a health check.
4. Confirm logs are captured per step and secrets are redacted.

### Known Linux-specific risks

1. ~~**`df -Pk` column order**~~ — resolved. The runtime image is Debian, so GNU coreutils, and
   columns 2 and 4 are total and available as the adapter assumes. Verified inside the image.
2. ~~**The long-running worker**~~ — built (`scripts/worker.ts`), shipped in the image, running on
   the VPS.
3. ~~**Docker socket permissions**~~ — resolved by `--group-add "$(getent group docker | cut -d: -f3)"`
   at run time, and the startup check now reports an `EACCES` there as a missing `--group-add`
   rather than letting it surface at the first deployment.
4. **Cloudflare in the verification path** — still open, and the highest-risk item remaining. The
   post-deployment check probes the public route with `User-Agent: DeployHub/health-check`. A
   Cloudflare 403 reads as a failed verification and **rolls back a deployment that worked**.
   Allowlist that User-Agent, or point `DEPLOYHUB_PUBLIC_*` at the origin, before the first real
   deployment of a Cloudflare-fronted app.

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

**Provisioned, hardened, and running DeployHub** as of 2026-08-02. Docker, git, nginx, and ufw are
installed; the data root is prepared; both containers are up.

No connection details are recorded in this repository — and none should be. Hostnames, IP
addresses, usernames, SSH keys, and passwords belong in the team's secret store, never in a file
that is committed. This document tracks _what has been done_, not _how to get in_.

---

## Next Development Plan

**Steps 1–15 are done.** The server is hardened and DeployHub is running on it. Resume at
[step 16](#platform-validation) — but do nginx first; it is not in this list because it was not
foreseen when the list was written, and it is now the immediate next action recorded under
[Current Development Phase](#current-development-phase).

### Server provisioning — ✅ complete

1. **First login to the VPS.**
2. **Update Ubuntu** — `apt update && apt full-upgrade`, then reboot if the kernel changed.
3. **Create a non-root sudo user.**
4. **Configure SSH keys** for that user.
5. **Disable password authentication** — _only after confirming key login works in a second, separate
   session._ Locking yourself out of a fresh VPS is the classic way to lose an afternoon.
6. **Secure the SSH configuration** — no root login, no password auth, key types explicit.
7. **Configure the firewall** — default deny inbound; allow SSH, 80, and 443. **Do not expose the
   dashboard port.**
8. **Install Git.**
9. **Install Docker** — from Docker's own apt repository, not the distro package.
10. **Install Docker Compose** if required. _(DeployHub itself does not use it; the applications being
    deployed may.)_
11. **Verify Docker** — `docker run --rm hello-world` as the non-root user, which also proves the group
    membership from step 9.

### DeployHub setup — ✅ complete

12. **Clone DeployHub.**
13. **Configure the environment** — see [Environment](#environment) below. The secrets file and the
    data root are created by `sudo docs/ops/install.sh`, which must run **before** the first
    `docker run`.
14. **Execute Linux Readiness validation** — work through `docs/ops/host-spike.md` command by command
    against this host, and resolve every `[verify on Linux]` marker.
15. **Fix Linux-specific issues** — expect `df -Pk` parsing and Docker socket permissions first.

### Platform validation — ⬅ **resume here**

15a. **Put nginx in front of the dashboard** — `docs/ops/nginx-deployhub.conf`, procedure in
`docs/docker.md` § nginx. Written and validated, not yet applied.

15b. **Register OneCommunity** through `/setup`: container name `one-community`, container port 3000. Both are read-only after creation.

16. **Validate Deploy** — a real deployment end to end. **Expect downtime**: the classic strategy
    (D12) stops and removes the previous container before starting the new one. The zero-downtime
    measurements taken on macOS were under the superseded candidate-then-promote design and no
    longer apply.
17. **Validate Rollback** — including the automatic path, by deliberately failing a health check.
18. **Validate Logs** — captured per step, complete, and with secrets redacted.
19. **Validate Worker** — verify the boot sweep recovers correctly when the worker container is
    killed mid-deployment, and that `--stop-timeout 1800` lets an ordinary stop drain instead.
20. **Deploy One Community Staging** as the first real application.

### Engineering work implied by the above

- ~~Long-running worker entrypoint~~ — done: `scripts/worker.ts`, run as its own container.
  No systemd unit; `--restart unless-stopped` is the supervisor.
- ~~`df -Pk` parsing~~ — confirmed inside the runtime image, which is Debian and therefore GNU
  coreutils. Columns 2 and 4 are total and available, as the adapter assumes.
- ~~Docker socket permissions~~ — `--group-add` at run time; the startup check now names it.
- A **deployment guide** in `docs/ops/` recording what was actually done to this server, so the next
  server does not require rediscovery. `docs/docker.md` covers the container side and
  `docs/ops/install.sh` covers host preparation; what is still missing is a record of the
  provisioning steps 1–11 as actually performed.

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
- **DeployHub does not touch the host's reverse proxy.** Deployed containers publish on a fixed
  port, so the proxy's upstream never moves. This is D12, and it is the decision that lets the
  platform be installed on a working server without redesigning it. The Caddy adapter that the
  superseded candidate-then-promote design required has been deleted.
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
| `DEPLOYHUB_BIND_HOST`     | Interface deployed containers publish on (`127.0.0.1`)          |
| `DEPLOYHUB_PUBLIC_SCHEME` | `http` or `https` (`https`)                                     |
| `DEPLOYHUB_PUBLIC_PORT`   | Public port the host's proxy serves (`443`)                     |
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

### 2026-08-02 (evening) — Paused. DeployHub is running on the VPS.

**Stop point.** Work paused here deliberately, not because anything is broken.

**State of the server.** `deployhub-web` and `deployhub-worker` both running.
`curl http://127.0.0.1:8080/signin` → 200. The worker reaches the host Docker daemon. The data
root is prepared and owned by uid 1000. **No project is registered and no deployment has ever
run.** The dashboard is reachable only on the host's loopback; nginx is not yet configured.

**Written today but not yet applied to the server:** `docs/ops/nginx-deployhub.conf`. Validated
against a real nginx — config parses, and a proxy test confirmed `Host`, `X-Real-IP`,
`X-Forwarded-For`, `X-Forwarded-Proto`, and `X-Forwarded-Port` all arrive correctly, with a
WebSocket upgrade returning 101. It has not been copied to `/etc/nginx/sites-available/` yet.

**To resume, in order.**

1. Apply the nginx site — `docs/docker.md` § nginx has the exact commands. Run
   `sudo nginx -T | grep -nE "listen|server_name"` first: OneCommunity shares this nginx, and a
   second `default_server` on port 80 would fail `nginx -t`.
2. Restrict port 80 before exposing it. `DEPLOYHUB_PASSWORD` is a root credential — the container
   holds the Docker socket — and plain HTTP puts it and the session cookie on the wire in
   cleartext. `ufw allow from <your ip> to any port 80 proto tcp`, or use
   `ssh -L 8080:127.0.0.1:8080` and skip nginx during validation.
3. Register OneCommunity: container name `one-community`, port 3000, both read-only after
   creation.
4. First deployment. **It will cause a short outage and has no rollback target** — the
   hand-started container carries no DeployHub labels, so baseline capture treats this as a first
   deploy. Pick a moment when that is acceptable.

**Open risks, unchanged.**

- 🔴 **Cloudflare can roll back a working deployment.** The post-deployment check probes the public
  route as `User-Agent: DeployHub/health-check`; a 403 reads as failed verification. Fix before
  deploying anything Cloudflare fronts.
- 🟡 **No deployment has ever run end to end.** Every stage is proven in isolation; the whole chain
  is not.
- 🟡 **No backups.** `/var/lib/deployhub` holds the only copy of `secrets.json`, and there is no
  migration runner, so snapshot before any upgrade.
- 🟡 **HTTPS deferred** by decision, to be added after MVP validation.

**Branch.** `classic-deployment-strategy`, pushed. `main` is still at `29cfb78` — the branch has
never been merged, and the pivot from candidate-then-promote to classic replacement lives entirely
on it.

---

### 2026-08-02 — First VPS install failed; startup check, installer, and `--mount`

**What happened.** The first production install put the containers up before the host was
prepared. Docker creates a missing bind-mount source as `root:root`, so `/var/lib/deployhub` was
unwritable by uid 1000. The worker crash-looped on `ERR_SQLITE_ERROR: unable to open database
file`. The web container was worse: `getPlatform()` is lazy, so Next reported ready, `/signin`
served 200, the container stayed `running`, and the failure waited for someone to open the
dashboard and get a 500.

The host-preparation step **was** documented and was skipped. That is not a satisfying root cause:
a step that can be skipped without immediate consequence will be, and the consequence surfaced
four layers from the cause. Three fixes, all shipped:

1. **Startup check** (`src/server/runtime/startup-check.ts`). Data root exists, is a directory, is
   writable — proved by writing a probe file, because permission bits do not catch a read-only
   mount. Workspace root likewise. `secrets.json` exists, is a file, is mode 600, is owned by this
   uid, is readable. Docker socket present and openable — an `EACCES` there is a missing
   `--group-add`, which is otherwise discovered at the first deployment. Every problem is reported
   together, each with the command that fixes it. The web process runs it in Next's `register()`
   hook (`src/instrumentation.ts`) so it fails at boot instead of false-greening; the exit lives in
   `boot.ts` because Next compiles instrumentation for the edge runtime too.
2. **`docs/ops/install.sh`.** Idempotent, `--dry-run`, and safe by construction: refuses system
   directories, symlinks, relative paths, `..`, paths shallower than two segments, and `--uid 0`.
   It **never chowns recursively** — it corrects the three paths it owns and _reports_ anything
   else with the command, so a mistyped `--root` cannot rewrite a tree.
3. **`--mount` instead of `-v`** for both required paths. Verified: on a daemon-side path `-v`
   silently creates `root:root` while `--mount` exits 125 with `bind source path does not exist`.

**Verified.** 441 tests. Against the real daemon: an unprepared host produces all four problems
with fixes and the web container crash-loops instead of serving; the installer repairs the exact
`root:root 0755` state and is a no-op on the second run; after it, both containers start, the
dashboard authenticates, the worker loops, and SQLite writes.

**Next immediate task.** Re-run the install on the VPS: `sudo docs/ops/install.sh`, then recreate
both containers with the `--mount` commands from `docs/docker.md`.

---

### 2026-08-02 — Classic Deployment Strategy; DeployHub containerized

**Completed.** Two things, in order.

_Containerization._ `Dockerfile` and `.dockerignore`, four stages, only the runner ships.
`output: "standalone"` halved the image (1.15 GB → 657 MB). Docker CLI + buildx copied from the
official image; Debian rather than Alpine so `df -Pk` matches the Ubuntu host. `docs/docker.md` is
the operational contract.

_The pivot._ A review of the MVP established that the objective is **replacing manual SSH
deployment**, not zero-downtime orchestration. Candidate-then-promote (D8) required a reverse proxy
the platform could reconfigure on every deployment, which meant DeployHub writing into
`/etc/nginx` on a production server it is supposed to leave alone. [D12](../architecture/decisions.md)
replaces it with stop → remove → run on a fixed port, and the requirement disappears.

Seven increments, gate green after each:

1. **Domain** — `rolling_back` reachable from `starting` and `health_checking`. Two entries in the
   transition table; the promotion boundary is now `docker run`.
2. **Engine** — replace instead of promote. `projectContainerName`, host-read baseline, rollback by
   digest, `ContainerRuntime.rename` deleted. Engine test suite rewritten.
3. **Proxy removal** — `ReverseProxy` port, Caddy adapter, two error codes, `DEPLOYHUB_CADDY_*`.
4. **Docker adapter** — fixed `-p <bindHost>:<port>:<port>`; reachable address read back from the
   daemon, with `0.0.0.0` normalised to loopback for probing.
5. **UI** — the impact boundary moved from `promoting` to `starting` in two places that would
   otherwise have told a reader production was fine while it was down.
6. **Worker** — `scripts/worker.ts`, shipped in the image and run as a second container. The alias
   hook no longer depends on `process.cwd()`.
7. **Documentation** — D12, the flow document, module docs, `docs/docker.md`, this file.

**426 tests, all passing.** Error catalogue 67 → 65.

**Verified on macOS/Docker Desktop.** Image builds; both containers run as uid 1000; the worker
loops and runs the boot sweep; `docker version`, `docker run hello-world`, and a real `docker build`
through buildx all work from inside the container; SQLite + WAL + SHM survive restart, container
replacement, and image rebuild. The real `DockerContainerRuntime` was driven through the full
classic sequence against the host daemon: build, start on a fixed port, **duplicate name refused**,
stop → remove → start reusing the same name and port.

**Remaining.** Linux validation on the VPS, then OneCommunity staging.

**Blockers.**

- 🟡 **No end-to-end deployment has run.** Every stage is proven except a real git-driven deployment,
  which needs a reachable repository and belongs on the VPS.
- 🟡 **`--group-add $(getent group docker)` is unproven on Ubuntu.** Docker Desktop presents the
  socket as `root:root`, so verification used `--group-add 0`. One `docker run` on the VPS settles it.
- 🟡 **Cloudflare can fail a good deployment.** The public-route check would read a 403 as a failed
  verification and roll back a working release. Allowlist the health-check User-Agent first.

**Next immediate task.** Provision the VPS and run the deployment steps in `docs/docker.md`.

---

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
