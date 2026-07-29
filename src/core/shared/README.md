# `core/shared` — domain kernel

The vocabulary the rest of `core/` is written in: `Result<T, E>`, the
`DeploymentError` taxonomy and its stable codes, branded ids (`ProjectId`,
`DeploymentId`, `ReleaseId`), `Duration`/`Timestamp`, and secret redaction.

This is the bottom of the dependency graph. It imports from nothing else in `src/`,
contains no business rules, and performs no I/O.

Full boundary: [`docs/architecture/modules.md`](../../../docs/architecture/modules.md#coreshared--domain-kernel).
