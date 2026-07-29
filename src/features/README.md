# `features/` — Vertical feature slices

Each subdirectory is a self-contained feature (e.g. `features/deployments/`,
`features/projects/`) that composes the UI and wiring for one product area.
Prefer colocating a feature's components, hooks, and server actions together so
features stay independently understandable and removable.

A typical feature:

```
features/<name>/
  components/    # React components specific to this feature
  hooks/         # client hooks
  actions.ts     # server actions (thin — delegate to core use cases)
```

Features orchestrate `core/` use cases and render with `components/`. Business
rules live in `core/`, not here. Routes in `src/app/` should stay thin and
delegate into the relevant feature.
