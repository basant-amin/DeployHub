/**
 * Invariant 1 — single writer per project.
 *
 * At most one deployment per project may be in a non-terminal state. The rule is
 * expressed here as a pure function over deployments the caller has already loaded,
 * because the domain must not query: an aggregate can only see itself, and a rule
 * that needs to see its siblings still belongs in the domain rather than in whichever
 * service happened to load them.
 *
 * Enforcement is layered. This is the rule; the use case applies it at admission; a
 * unique constraint in the database is the backstop for the race the check cannot
 * close on its own. All three are needed — the check gives a good error message, the
 * constraint guarantees correctness.
 *
 * Callers pass the deployments **for one project**. There is no project id parameter,
 * because taking one would imply this function filters by it, and a signature that
 * implies a guarantee it does not provide is worse than no parameter at all.
 */

import { type IdempotencyKey, type Result, DeploymentError, err, ok } from "@/core/shared";

import type { Deployment } from "./deployment";

/** The project's in-flight deployment, if it has one. */
export function findActiveDeployment(deployments: readonly Deployment[]): Deployment | undefined {
  return deployments.find((deployment) => !deployment.isTerminal);
}

/**
 * Gate admission of a new deployment.
 *
 * Release 1 rejects rather than queues (`docs/architecture/decisions.md` § D6), so
 * the failure is `PRECONDITION`: the request was well-formed, the project is simply
 * busy, and the operator keeps the decision about what to do next.
 */
export function ensureNoActiveDeployment(deployments: readonly Deployment[]): Result<void> {
  const active = findActiveDeployment(deployments);
  if (active === undefined) {
    return ok(undefined);
  }
  return err(
    DeploymentError.of(
      "DEPLOYMENT_IN_PROGRESS",
      `Deployment ${active.id} is already in progress for this project (state "${active.state}")`,
      {
        details: {
          projectId: active.projectId,
          activeDeploymentId: active.id,
          activeState: active.state,
        },
      },
    ),
  );
}

/**
 * Find a prior deployment for a replayed idempotency key.
 *
 * Returning the existing deployment instead of starting a second one is what makes a
 * double-clicked Deploy button harmless rather than a race for the lock.
 */
export function findByIdempotencyKey(
  deployments: readonly Deployment[],
  idempotencyKey: IdempotencyKey,
): Deployment | undefined {
  return deployments.find((deployment) => deployment.idempotencyKey === idempotencyKey);
}
