# Module responsibilities

One module, one reason to change. Each entry below states its **purpose**, its
**responsibilities**, what it **owns** (the concepts and artifacts no other module
may define), and what it **must never do** — the boundary that keeps the module
from quietly growing into something else.

The "must never" lines are the operative part of this document. Responsibilities
tend to be obvious in review; boundary violations are what actually erode an
architecture, and they are only catchable if they were written down first.

## Map

| Module                         | Layer          | Reason to change                             |
| ------------------------------ | -------------- | -------------------------------------------- |
| `core/shared`                  | domain kernel  | A new cross-cutting primitive or error class |
| `core/domain/projects`         | domain         | What is deployable, and how it is configured |
| `core/domain/deployments`      | domain         | The lifecycle, its states and its rules      |
| `core/ports`                   | seam           | A new capability the engine needs            |
| `core/application/engine`      | orchestration  | The shape of the deployment flow             |
| `core/application/use-cases`   | orchestration  | A new operation the product offers           |
| `core/application/policies`    | orchestration  | Tunable rules: health, retry, retention      |
| `server/adapters/ssh`, `local` | infrastructure | How commands reach a host                    |
| `server/adapters/git`          | infrastructure | Git CLI surface                              |
| `server/adapters/docker`       | infrastructure | Docker CLI surface                           |
| `server/adapters/health`       | infrastructure | How an HTTP probe is issued                  |
| `server/adapters/logs`         | infrastructure | Where log lines are stored and streamed      |
| `server/adapters/lock`         | infrastructure | How the lease is persisted                   |
| `server/adapters/persistence`  | infrastructure | Storage engine and schema                    |
| `server/runtime`               | hosting        | How the worker process runs and is wired     |
| `features/*`                   | inbound        | Product surface and screens                  |
| `config`                       | configuration  | A new environment variable                   |
| `lib`                          | utilities      | A new UI/formatting helper                   |

---

## `core/shared` — domain kernel

**Purpose.** The vocabulary every other core module uses, so they can share types
without depending on each other.

**Responsibilities.** `Result<T, E>` for expected failures; the `DeploymentError`
type and its stable code taxonomy; branded ids (`ProjectId`, `DeploymentId`,
`ReleaseId`) so they cannot be swapped at a call site; `Duration` and `Timestamp`
value objects; the secret-redaction function used by the log boundary.

**Owns.** Error codes and classes. The id types. The redaction rules.

**Must never.** Contain business rules. Import from any other module — it is the
bottom of the graph, and anything it needs to import belongs somewhere else.
Perform I/O.

## `core/domain/projects` — what is deployable

**Purpose.** Model the deployable unit and the configuration that governs its
deployment.

**Responsibilities.** The `Project` entity. `DeployConfig` (repository and
credential reference, target ref, Dockerfile path and build context, build args,
runtime env reference, container port, public route, image retention).
`HealthCheckSpec` (path, expected status, interval, required consecutive passes,
total budget) as a validated value object. Whole-config validation — the
cross-field rules a per-field check cannot express, such as a health path with no
container port.

**Owns.** The definition of a valid deployment configuration. Config invariants.

**Must never.** Read configuration from disk, environment, or database — it
validates configuration that is handed to it. Hold secret _values_; it holds
references that the secret provider resolves. Know that Docker exists: a
Dockerfile path is data to this module, not behavior.

## `core/domain/deployments` — the lifecycle

**Purpose.** The heart of the platform: what a deployment is and how it may
legally change.

**Responsibilities.** The `Deployment` aggregate (target ref, resolved sha,
trigger, actor, state, baseline, timing, error, warnings, per-step records). The
**state machine** and its transition guard — the single authority on whether a
transition is legal. The `Baseline` value object (container id, image tag and
digest, commit sha, proxy target). The `Release` entity recording what shipped.
Rollback eligibility rules. The invariants in
[`deployment-engine.md` § Invariants](./deployment-engine.md#invariants).

**Owns.** The set of states and every legal transition between them. The rule that
promotion requires a passed health check. What "succeeded" means.

**Must never.** Execute a step or call a port. Know the difference between Docker
and Kubernetes. Read the clock — timestamps are passed in, which is what makes the
state machine testable without freezing time. Depend on how a deployment is
persisted.

## `core/ports` — the seam

**Purpose.** Express every capability the engine needs as an interface, in the
engine's language rather than a vendor's.

**Responsibilities.** `GitClient` (put the workspace at a ref, return the resolved
sha). `ContainerRuntime` (build, start, inspect, stop, remove, list by label,
remove images, report storage headroom). `HealthProbe` (one attempt, one result).
`DeployLock` (acquire, heartbeat, release, find expired — all fenced).
`DeploymentLogSink` (open with a redactor, append, complete, read, tail).
`EventPublisher`. `ProjectRepository`, `DeploymentRepository`,
`ReleaseRepository`. `SecretProvider`. `Clock`. `IdGenerator` (ids only).

**Not a port.** `CommandRunner` — "run a process on _a_ host" — is a transport the
git, container, and proxy adapters share, and the application layer never calls it.
It therefore lives with the adapters that compose it (`server/adapters/`), not at a
boundary the engine depends on: declaring it here would invert a dependency that
does not cross the layer. Decision D3 is unchanged — SSH remains a transport the tool
adapters compose rather than a peer capability.

Internal port allocation is not here either. Only the host knows which ports are
free, so `ContainerRuntime.startContainer` reports the address it actually bound.

**Owns.** The vocabulary of the boundary. Nothing else may define an interface the
engine depends on.

**Must never.** Contain logic, defaults, or retry behavior — ports are declarations.
Leak vendor concepts into their signatures: no `DockerContainerInspectOutput` in a
port type, or the abstraction has bought nothing. Be implemented inside `core/`
(other than test fakes).

One port carries the future of the platform: `ContainerRuntime` is exactly what a
Kubernetes adapter would implement. Keeping it container-orchestrator-neutral in
_naming_ and _granularity_ is the whole cost of that option, and it is worth paying
now.

## `core/application/engine` — the deployment engine

**Purpose.** Turn a deployment request into a guarded, compensable, observable
sequence of port calls.

**Responsibilities.** Define the steps and the pipeline. Enforce per-step timeouts
and the total budget. Apply the retry policy. Check cancellation at boundaries.
Record every transition through the domain's guard. Stream step logs. On failure,
classify the error, unwind compensations in reverse, and select the terminal state.
Always release the lock (except `rollback_failed`).

**Owns.** The order of steps. What each failure means. The compensation strategy.

**Must never.** Import from `server/`. Construct an adapter — it receives ports.
Shell out or build a command string; `docker build …` never appears in this module.
Touch `process.env`, the filesystem, or a network socket. Write to the database
directly instead of through a repository port. Contain a `try/catch` that decides
recovery inside a step — the runner owns failure.

## `core/application/use-cases` — operations

**Purpose.** The application's public verbs, each one transaction of intent.

**Responsibilities.** `RequestDeployment` (validate, dedupe by idempotency key,
enforce single-active-per-project, persist `queued`, enqueue).
`CancelDeployment`. `RequestRollback` (resolve a target release and request a
deployment with `trigger: rollback`). `GetDeploymentStatus`, `StreamDeploymentLogs`.
`RecoverInterruptedDeployments` (the reconciliation decision logic — the runtime
schedules it, this decides it).

**Owns.** Admission rules. The mapping from user intent to engine work.

**Must never.** Contain step logic that belongs to the engine. Return
infrastructure types to callers. Assume an HTTP context — no requests, headers, or
cookies. Perform authorization; that is the inbound layer's job.

## `core/application/policies` — tunable rules

**Purpose.** Isolate the decisions most likely to be tuned in production, as pure
functions.

**Responsibilities.** Health evaluation (given attempts so far, pass / fail /
continue). Retry policy (given error class, step, attempt → retry with what delay).
Image and container retention selection. Rollback eligibility. Disk headroom
threshold.

**Owns.** Every tunable number in the platform, in one findable place.

**Must never.** Perform the action it decides on — a policy returns a decision, the
engine acts on it. Read configuration from the environment. Sleep or wait; it
returns a delay, the runner waits.

## `server/adapters/ssh` and `server/adapters/local` — transport

**Purpose.** Implement `CommandRunner`: get a command executed on a host and its
streams back.

**Responsibilities.** Connection setup, key-based auth, connection reuse,
per-command timeout and kill, exit-code and stream capture, incremental stream
delivery for live logs, mapping transport failures to `TRANSIENT` errors. `local/`
is the same contract over `child_process`, used in development and tests.

**Owns.** How a process is executed and how its output is captured.

**Must never.** Know what it is running. There is no `docker` or `git` string in
this module — that is the entire point of the abstraction, and violating it puts
tool knowledge in two places. Interpret exit codes semantically (a non-zero exit
is a result, not a build failure). Retry on its own; retry is policy. Log raw
arguments without redaction. Interpolate untrusted input into a shell string —
arguments are passed as an array.

Making SSH a **transport** rather than a peer module of `docker` and `git` is the
main structural correction to the initial module sketch. See
[decisions § D3](./decisions.md#d3--ssh-is-a-transport-not-a-capability-module).

## `server/adapters/git` — source access

**Purpose.** Implement `GitClient` over `CommandRunner`.

**Responsibilities.** Clone on first use; `fetch --prune`; hard checkout to a clean
tree; resolve a ref to an immutable sha; read the workspace's current sha; inject
credentials without exposing them on the command line; translate git exit codes
into typed errors (auth failed vs. unknown ref vs. network).

**Owns.** Every git invocation in the codebase. The workspace layout on disk.

**Must never.** Decide _which_ ref to deploy. Merge, rebase, or push — DeployHub
reads history, it does not write it. Talk to a Git _hosting API_ (that is a
separate future adapter for webhooks and status checks). Execute a process
directly instead of through `CommandRunner`.

## `server/adapters/docker` — container runtime

**Purpose.** Implement `ContainerRuntime` over `CommandRunner`.

**Responsibilities.** Build with tags and labels; run with env, ports, restart
policy and labels; inspect state and health; rename; stop with a grace period;
remove; list containers and images by DeployHub label; prune a given set; read
container logs; report disk headroom. Translate Docker failures into typed errors.

**Owns.** Every `docker` invocation. Container and image naming and labeling
conventions. Nothing else may name a container.

**Must never.** Decide whether to promote, roll back, or retry. Interpret a health
check result. Choose which images to prune (it prunes the set it is given). Stop or
remove the live container on its own initiative — destructive operations are always
explicitly targeted by the caller. Assume it is the only container runtime that
will ever exist.

## `server/adapters/proxy` — removed (D12)

There is no proxy adapter. Under classic replacement the container publishes on a
fixed port, so the host's reverse proxy holds one static upstream and is never
reconfigured by the platform — which is the property that lets DeployHub be
installed on a working server without changing it.

The module returns if zero-downtime deployment does. Its contract is written in
[D8](decisions.md#d8--candidate-then-promote-not-stop-then-start) and the deleted
`ReverseProxy` port is in git history.

## `server/adapters/health` — probes

**Purpose.** Implement `HealthProbe`: issue one HTTP request and report one result.

**Responsibilities.** Request the health path with a timeout, against either an
internal container port or the public route; return status, latency, and a body
excerpt; classify a connection refusal distinctly from a 500.

**Owns.** How a single probe is performed.

**Must never.** Loop, sleep, or count attempts — thresholds and budgets are policy
in `core`, and putting them here would hide the platform's most-tuned numbers in an
adapter. Decide that a deployment is unhealthy. Follow redirects silently, or
otherwise interpret the response beyond what the spec asks.

## `server/adapters/logs` — deployment logs

**Purpose.** Implement `LogSink`: durable, append-only, streamable deployment logs.

**Responsibilities.** Append structured lines (deployment id, step, timestamp,
stream, text); apply redaction at the boundary; expose a live tail for the UI and a
complete read for a finished deployment; enforce per-deployment size caps with
truncation markers; mark the artifact complete.

**Owns.** Log storage location, format, retention, and truncation.

**Must never.** Be treated as, or become, the source of truth for deployment
status — status lives on the deployment record, and a UI that infers "succeeded"
from log text is a defect. Lose the record if writing a line fails: a log write
failure is a warning, never a deployment failure. Store an unredacted secret.

## `server/adapters/lock` — the lease

**Purpose.** Implement `DeployLock`: single-writer, crash-safe, fenced.

**Responsibilities.** Atomic conditional acquire (insert-if-absent or take-over-if-
expired) returning an incremented epoch; heartbeat renewal; epoch-conditional
release; the advisory `flock` on the target host; expose expired-lease holders for
the reconciler.

**Owns.** The lease record, TTL enforcement, and epoch allocation.

**Must never.** Grant a lock without a lease and a fencing token. Allow a
non-atomic check-then-set. Let a stale holder release a current lock. Block or
queue waiting for the lock — acquisition either succeeds now or fails. Silently
extend a lease it no longer holds.

## `server/adapters/persistence` — storage

**Purpose.** Implement the repository ports.

**Responsibilities.** Map domain objects to rows and back; enforce the unique
constraints the invariants depend on (one active deployment per project, one lock
row per project, idempotency key uniqueness); provide the queries the UI and
reconciler need; own migrations.

**Owns.** The schema, migrations, and every query.

**Must never.** Leak ORM or row types past its own boundary. Contain business rules
in SQL that belong in the domain. Let a caller construct a deployment in an illegal
state — the aggregate is reconstituted through the domain, not assembled field by
field.

Schema and models are explicitly **not** part of this phase; this entry defines the
boundary the phase that adds them must respect.

## `server/runtime` — process hosting

**Purpose.** Make the engine actually run: wire it, host it, keep it alive.

**Responsibilities.** The **composition root** — the one place in the codebase that
chooses concrete adapters and injects them. The worker loop that picks up queued
deployments and runs the pipeline one at a time per project. The heartbeat
scheduler. The boot and periodic reconciler sweep. Graceful shutdown: stop
accepting work, let the current step finish or time out, release the lock. Startup
self-checks.

**Owns.** Process lifecycle, dependency wiring, scheduling.

**Must never.** Contain deployment logic — if a rule lives here, it is in the wrong
layer. Be imported by `core/`. Be imported by a client component. Run more than one
deployment per project concurrently. Assume it shares a process with the web
server: it is designed to be extractable into its own process without any change
to `core/`, because long-running work does not belong in a request lifecycle. See
[decisions § D7](./decisions.md#d7--the-engine-runs-in-a-long-lived-worker-not-a-request-handler).

## `features/*` — product surface

**Purpose.** The screens: trigger a deploy, watch it, read history, roll back.

**Responsibilities.** Compose UI, call use cases, subscribe to status and log
streams, render states and errors from their codes.

**Must never.** Import `server/adapters/*`. Call Docker, git, or SSH — directly or
transitively. Reimplement state logic (for example deciding a deployment is
rollback-eligible in a component). Display an unredacted secret. Own the meaning of
a state; it renders what the domain reports.

## `config` and `lib`

`config` owns environment validation and typed configuration, validated once at
startup so the process refuses to boot misconfigured (already implemented in
`src/config/env.ts`). It must never be read from `core/` — configuration is passed
in, not reached for.

`lib` holds cross-cutting, dependency-free utilities (`cn`, formatting). It must
never contain domain logic or I/O; a helper that knows what a deployment is belongs
in `core`.
