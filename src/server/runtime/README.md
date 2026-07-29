# `server/runtime` — process hosting

Makes the engine run. Contains no deployment logic — if a rule lives here, it is in
the wrong layer.

- `composition.ts` — the composition root: the only place concrete adapters are
  chosen and injected.
- `worker.ts` — the loop that picks up queued deployments and runs the pipeline, one
  at a time per project.
- `heartbeat.ts` — lock lease renewal.
- `reconciler.ts` — boot-time and periodic recovery of interrupted deployments.

Release 1 may host the worker inside the Next.js process, but nothing in `core/`
depends on that: a deployment takes minutes and must outlive the request that
triggered it, so this module is built to be extracted into its own process without
touching the engine. Rationale:
[`decisions.md` § D7](../../../docs/architecture/decisions.md#d7--the-engine-runs-in-a-long-lived-worker-not-a-request-handler).

Recovery design:
[`deployment-engine.md` § Recovery](../../../docs/architecture/deployment-engine.md#recovery-strategy).
