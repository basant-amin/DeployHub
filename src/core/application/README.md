# `core/application` — orchestration

Depends on `core/domain`, `core/ports`, and `core/shared`, and on nothing else. It receives
ports; it never constructs an adapter, builds a command string, reads `process.env`, or opens
a socket. That is what makes the whole layer — including both compensation paths — testable
in memory in under a second.

| Module                                | Contents                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `engine/deployment-engine.ts`         | The pipeline: one `run` method, written in the order of the flow document |
| `use-cases/request-deployment.ts`     | Admission: validate, dedupe, refuse a busy project, queue                 |
| `use-cases/request-rollback.ts`       | Queue a deployment of an older release's exact commit                     |
| `use-cases/get-deployment-history.ts` | The overview card and the deployment list                                 |
| `use-cases/get-deployment-detail.ts`  | Timeline, steps, warnings, and the log                                    |
| `use-cases/mappers.ts`                | Aggregate → read model, in one place                                      |
| `read-models.ts`                      | Plain serializable shapes the dashboard renders                           |
| `policies/health-policy.ts`           | Pass / retry / fail, as a pure function over attempts                     |
| `policies/retention-policy.ts`        | Which image digests may be removed                                        |
| `policies/container-naming.ts`        | One container name per deployment                                         |
| `policies/thresholds.ts`              | Every tunable number in the platform                                      |

`engine/engine.fixtures.ts` provides in-memory ports for tests. They _behave_ — the proxy
remembers where a route points, the container runtime remembers what it started — which is
what lets a test assert the thing that matters after a failed deployment: the previous
release is still serving traffic.

## Three narrowings of the architecture, for the MVP

**No step-pipeline framework.** § D2 called for steps as data with per-step compensation. The
flow has eleven steps and exactly two compensations — discard the candidate, or restore the
previous release — chosen by one fact: whether traffic has been switched. A generic
reverse-unwinding stack would be a mechanism for a case that does not exist. Step _records_
are kept; the timeline is built on them.

**No renaming at promotion.** Flow step 28 renames the candidate to a canonical name and the
outgoing container to `<slug>-previous-…`. It cannot be made collision-free: the previous
container is kept after finalization, so the next deployment's rename lands on a name already
taken. A container is named for the deployment that created it and keeps that name. Identity
never depended on names — the proxy's upstream says what is live, labels say what built it.

**No retries, cancellation, or event publishing.** Not in the MVP scope. A failure is
reported and the operator decides. `EventPublisher` is the one port with no consumer yet;
wiring it later is a call inside `apply`.

## What the next phase plugs in

Every port is constructed once, in a composition root that does not exist yet. The engine
takes them as one object, so wiring is a single literal:

`Clock` and `IdGenerator` → local. `GitClient` → git over the local command runner.
`ContainerRuntime` → Docker. `ReverseProxy` → Caddy's admin API. `SecretProvider` → a 0600
file. `DeploymentLogSink` → append-only file. All three repositories and `DeployLock` →
SQLite. The worker loop polls `DeploymentRepository.findQueued` and calls
`DeploymentEngine.run`.
