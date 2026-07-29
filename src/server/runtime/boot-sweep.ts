/**
 * Boot sweep — the minimum recovery the platform cannot ship without.
 *
 * A worker dying mid-deployment is not exotic: a host reboot, an OOM kill, or a deploy of
 * DeployHub itself will do it. Without this, the deployment sits in `building` forever, its
 * lease is never released, every subsequent deployment is refused, and the platform is unusable
 * until someone intervenes by hand.
 *
 * This implements **one** of the architecture's seven reconciliation cases: mark the deployment
 * failed, remove the containers it left behind, release the lease. It does not attempt to
 * complete a promotion that was in flight or restart a baseline from its digest. Those require
 * comparing host state against the record, and a recovery that guesses wrong turns a stalled
 * deployment into an outage — which is the more expensive of the two mistakes.
 *
 * The consequence, stated rather than hidden: a deployment interrupted between the proxy switch
 * and finalization is marked failed while its container is in fact still serving traffic. The
 * route keeps working, the record is pessimistic, and the next deployment corrects it — because
 * baseline capture reads the proxy rather than the record.
 */

import { type Result, DeploymentError, ok } from "@/core/shared";
import type { Deployment } from "@/core/domain";

import type { Platform } from "./composition";

export interface SweepReport {
  /** Deployments whose worker is gone, now marked failed. */
  readonly recovered: readonly string[];
  /** Leases released, so those projects can be deployed again. */
  readonly leasesReleased: number;
  /** Containers removed because they belonged to an abandoned deployment. */
  readonly containersRemoved: number;
}

export async function runBootSweep(platform: Platform): Promise<Result<SweepReport>> {
  const now = platform.clock.now();

  const expired = await platform.lock.findExpired(now);
  if (!expired.ok) {
    return expired;
  }
  const unfinished = await platform.deployments.findUnfinished();
  if (!unfinished.ok) {
    return unfinished;
  }

  // A queued deployment holds no lease, so it is not abandoned — it simply has not started, and
  // the worker will pick it up. Only a non-terminal deployment whose lease has expired had a
  // worker that is gone.
  const abandoned = unfinished.value.filter((deployment) =>
    expired.value.some((lease) => lease.deploymentId === deployment.id),
  );

  const recovered: string[] = [];
  let containersRemoved = 0;

  for (const deployment of abandoned) {
    containersRemoved += await removeItsContainers(platform, deployment);
    const marked = await markAbandoned(platform, deployment);
    if (marked.ok) {
      recovered.push(deployment.id);
    }
  }

  let leasesReleased = 0;
  for (const lease of expired.value) {
    const released = await platform.lock.release(lease);
    if (released.ok) {
      leasesReleased += 1;
    }
  }

  return ok({ recovered, leasesReleased, containersRemoved });
}

/**
 * Remove every container labelled with this deployment.
 *
 * Found by label rather than from the deployment's own `candidate` field, because a worker can
 * die after `docker run` but before the record was saved — in which case the record has no
 * candidate and the container is still there. The label is on the host, which is the thing that
 * is true.
 */
async function removeItsContainers(platform: Platform, deployment: Deployment): Promise<number> {
  const project = await platform.projects.findById(deployment.projectId);
  if (!project.ok || project.value === undefined) {
    return 0;
  }

  const containers = await platform.containers.findForProject(project.value);
  if (!containers.ok) {
    return 0;
  }

  let removed = 0;
  for (const container of containers.value) {
    if (container.deploymentId !== deployment.id) {
      continue;
    }
    // Never remove a container the proxy is pointing at: if this deployment's container is
    // serving traffic, taking it away would turn a bookkeeping problem into an outage.
    const live = await platform.proxy.readUpstream(project.value.config.route);
    if (
      live.ok &&
      live.value !== undefined &&
      container.upstream !== undefined &&
      live.value.host === container.upstream.host &&
      live.value.port === container.upstream.port
    ) {
      continue;
    }
    const gone = await platform.containers.remove(container.id);
    if (gone.ok) {
      removed += 1;
    }
  }
  return removed;
}

async function markAbandoned(
  platform: Platform,
  deployment: Deployment,
): Promise<Result<Deployment>> {
  const at = platform.clock.now();
  const interrupted = deployment.markInterrupted(at, "the worker did not finish");
  if (!interrupted.ok) {
    return interrupted;
  }
  const failed = interrupted.value.resolveInterruptedAsFailed(
    at,
    DeploymentError.of(
      "INVARIANT_VIOLATION",
      "The worker running this deployment stopped before it finished; recovered at boot",
    ),
  );
  if (!failed.ok) {
    return failed;
  }
  const saved = await platform.deployments.save(failed.value);
  return saved.ok ? ok(failed.value) : saved;
}
