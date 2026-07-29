# `core/domain` — entities, value objects, invariants

Pure business rules. No I/O, no clock, no randomness, and no knowledge that Docker or
Git exist. Timestamps and ids are passed in, which is what keeps the state machine
deterministically testable.

## `projects/` — what is deployable, and how

| Module                 | Contents                                                                  |
| ---------------------- | ------------------------------------------------------------------------- |
| `project.ts`           | `Project` — identity, config, and the enabled switch                      |
| `deploy-config.ts`     | `DeployConfig`. No cross-field rules; the file explains why               |
| `health-check-spec.ts` | `HealthCheckSpec` — including the rule that a spec must be _able_ to pass |
| `build-args.ts`        | `BuildArgs` — names and value types only                                  |
| `image-retention.ts`   | `ImageRetention` — floor of two, so rollback never depends on a rebuild   |
| `public-route.ts`      | `PublicRoute` — host and path kept pre-split                              |
| `project-name.ts`      | `ProjectName` (renameable) and `ProjectSlug` (stable, DNS-safe)           |

## `deployments/` — the lifecycle, and what it produces

| Module                      | Contents                                                                         |
| --------------------------- | -------------------------------------------------------------------------------- |
| `deployment.ts`             | The `Deployment` aggregate — owns its lifecycle; illegal transitions unreachable |
| `deployment-state.ts`       | The state machine: 16 states, the transition table, lock disposition             |
| `deployment-consistency.ts` | Every rule a stored record must satisfy, re-checked on load                      |
| `baseline.ts`               | `Baseline` (a union — "nothing to roll back to" is stated, not discovered)       |
| `candidate.ts`              | `CandidateContainer` — running, not yet serving traffic                          |
| `release.ts`                | `Release` — only obtainable from a verified success                              |
| `rollback.ts`               | Rollback eligibility, with a reason for every refusal                            |
| `concurrency.ts`            | Invariant 1 — single writer per project                                          |
| `step.ts`                   | The eleven steps and their records                                               |
| `warning.ts`                | `DeploymentWarning` — a problem that did not fail the deployment                 |

## The invariants

Specified in
[`docs/architecture/deployment-engine.md`](../../../docs/architecture/deployment-engine.md#invariants).
Each is enforced in `deployment.ts` — structurally where possible — re-checked by
`deployment-consistency.ts` when a record is loaded, and covered by a test that names
it.

Invariant 4 is the one to read twice. Promotion requires a passed health check, **and
no deployment reports `outcome: deployed` without recorded verification through its
public route** — including via reconciliation, which reaches `succeeded` from
`interrupted` without passing through `finalizing`. That second clause is what makes
every `Release`, and therefore every rollback target, a release that was confirmed
reachable.
