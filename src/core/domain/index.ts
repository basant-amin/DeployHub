/**
 * The domain layer's public surface.
 *
 * Two bounded contexts: `projects` (what is deployable, and how) and `deployments`
 * (the lifecycle, and what it produces). Nothing here performs I/O, reads a clock, or
 * knows that Docker, Git, or a database exist.
 */

export * from "./projects";
export * from "./deployments";
