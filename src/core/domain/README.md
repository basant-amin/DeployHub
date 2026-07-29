# `core/domain` — entities, value objects, invariants

Pure business rules. One subdirectory per bounded context:

- `projects/` — `Project`, `DeployConfig`, `HealthCheckSpec`, and config validation.
  What is deployable and how.
- `deployments/` — the `Deployment` aggregate, the **state machine and its transition
  guard**, `Baseline`, `Release`, and rollback eligibility. The lifecycle authority.

No I/O, no clock, no randomness, no knowledge that Docker or Git exist. Timestamps
and ids are passed in, which is what keeps the state machine deterministically
testable.

See [`docs/architecture/deployment-engine.md`](../../../docs/architecture/deployment-engine.md)
for the states and invariants, and
[`docs/architecture/modules.md`](../../../docs/architecture/modules.md#coredomainprojects--what-is-deployable)
for the boundaries.
