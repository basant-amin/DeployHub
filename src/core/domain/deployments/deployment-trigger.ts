/**
 * What caused a deployment, and how it ended.
 *
 * `rollback` is a trigger rather than a separate mechanism: rolling back means
 * deploying an older commit through the same pipeline, so it gets the same
 * validation, locking, health checking, and route verification as any other deploy
 * (`docs/architecture/decisions.md` § D5).
 */

import { type Result, DeploymentError, err, ok } from "@/core/shared";

export const DEPLOYMENT_TRIGGERS = ["manual", "rollback"] as const;

export type DeploymentTrigger = (typeof DEPLOYMENT_TRIGGERS)[number];

/**
 * Validate a trigger.
 *
 * The aggregate takes typed value objects for everything else, but re-checks this one
 * because it is a bare union rather than a branded type: a cast at a boundary can
 * produce a `DeploymentTrigger` that was never validated, and the trigger decides how
 * a deployment is presented for the rest of its life.
 */
export function parseDeploymentTrigger(raw: unknown): Result<DeploymentTrigger> {
  return typeof raw === "string" && (DEPLOYMENT_TRIGGERS as readonly string[]).includes(raw)
    ? ok(raw as DeploymentTrigger)
    : err(
        DeploymentError.of(
          "DEPLOYMENT_INVALID",
          `Deployment trigger must be one of ${DEPLOYMENT_TRIGGERS.join(" | ")}`,
        ),
      );
}

/**
 * How a successful deployment succeeded.
 *
 * `no_change` is the no-op short circuit — the resolved sha was already live, so
 * nothing was built, restarted, or switched. It is a success, but conflating it with
 * `deployed` would make the deployment history claim releases that never happened.
 */
export const DEPLOYMENT_OUTCOMES = ["deployed", "no_change"] as const;

export type DeploymentOutcome = (typeof DEPLOYMENT_OUTCOMES)[number];
