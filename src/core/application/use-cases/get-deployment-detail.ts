/**
 * `GetDeploymentDetail` — the timeline, the steps, and the log.
 *
 * Returns the log alongside the deployment rather than behind a second query. The detail
 * screen polls this one call while a deployment is active, and `isActive` on the result is
 * what tells it when to stop — so the polling loop needs no separate status check.
 *
 * Returning the log inline is right for the MVP scale (one deployment at a time, a log
 * measured in hundreds of lines) and is the thing to revisit first if logs grow: the port
 * already offers `tail` for that.
 */

import { type DeploymentId, type Result, DeploymentError, err, ok } from "@/core/shared";
import type { DeploymentLogSink, DeploymentRepository } from "@/core/ports";

import type { DeploymentDetail } from "../read-models";
import { toDetail } from "./mappers";

export interface GetDeploymentDetailPorts {
  readonly deployments: DeploymentRepository;
  readonly logs: DeploymentLogSink;
}

export interface GetDeploymentDetailInput {
  readonly deploymentId: DeploymentId;
}

export class GetDeploymentDetail {
  constructor(private readonly ports: GetDeploymentDetailPorts) {}

  async execute(input: GetDeploymentDetailInput): Promise<Result<DeploymentDetail>> {
    const deployment = await this.ports.deployments.findById(input.deploymentId);
    if (!deployment.ok) {
      return deployment;
    }
    if (deployment.value === undefined) {
      return err(
        DeploymentError.of(
          "DEPLOYMENT_NOT_FOUND",
          `Deployment ${input.deploymentId} does not exist`,
          {
            details: { deploymentId: input.deploymentId },
          },
        ),
      );
    }

    // A missing or unreadable log must not hide the deployment record. The record is the
    // source of truth for what happened; the log is a diagnostic artifact beside it.
    const logs = await this.ports.logs.read(input.deploymentId);
    return ok(toDetail(deployment.value, logs.ok ? logs.value : []));
  }
}
