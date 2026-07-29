/**
 * The application layer — orchestration.
 *
 * Depends on `core/domain`, `core/ports`, and `core/shared`, and on nothing else. It
 * receives ports; it never constructs an adapter, builds a command string, reads
 * `process.env`, or touches a socket. That is what makes the whole of it — including both
 * compensation paths — testable in memory in milliseconds.
 *
 * Three parts:
 *
 * - `engine/` — the deployment pipeline, written as a straight line in the order of the
 *   flow document.
 * - `use-cases/` — the four MVP verbs, each one transaction of intent.
 * - `policies/` — the tunable decisions, as pure functions.
 */

export * from "./engine";
export * from "./use-cases";
export * from "./policies";
export * from "./read-models";
