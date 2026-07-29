/**
 * The worker — the process that actually deploys.
 *
 * A loop: sweep on boot, then take one queued deployment at a time and run it to a terminal
 * state. That is the entire coordination mechanism, and it is enough because release 1 rejects
 * concurrent deployments rather than queueing them, so there is never more than one to run.
 *
 * It runs in its own process rather than inside the web server. A deployment takes minutes and
 * must outlive the request that triggered it; hosting it in a request handler would tie its
 * lifetime to a connection and to whatever proxy timeout sits in front of the app.
 *
 * Polling rather than a queue or a notification: one SQL query per second against an indexed
 * column, and nothing to keep alive or reconnect. When that stops being enough, the seam is
 * `DeploymentRepository.findQueued`.
 */

import {
  type Duration,
  type Result,
  Duration as DurationCodec,
  ok,
  unwrapOrThrow,
} from "@/core/shared";

import { runBootSweep } from "./boot-sweep";
import type { Platform } from "./composition";

export interface WorkerOptions {
  /** How long to wait when there was nothing to do. */
  readonly idlePollMillis: number;
  /** Stop after this many deployments. Used by the demonstration script; omit to run forever. */
  readonly maxDeployments?: number;
}

export const DEFAULT_WORKER_OPTIONS: WorkerOptions = { idlePollMillis: 1_000 };

export class Worker {
  private stopping = false;

  constructor(
    private readonly platform: Platform,
    private readonly options: WorkerOptions = DEFAULT_WORKER_OPTIONS,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  /** Ask the loop to finish the deployment it is on and then return. */
  stop(): void {
    this.stopping = true;
  }

  async run(): Promise<Result<{ readonly deploymentsRun: number }>> {
    const swept = await runBootSweep(this.platform);
    if (!swept.ok) {
      return swept;
    }
    if (swept.value.recovered.length > 0) {
      this.log(
        `boot sweep recovered ${swept.value.recovered.length} abandoned deployment(s), ` +
          `released ${swept.value.leasesReleased} lease(s), ` +
          `removed ${swept.value.containersRemoved} container(s)`,
      );
    }

    let deploymentsRun = 0;
    while (!this.stopping) {
      if (
        this.options.maxDeployments !== undefined &&
        deploymentsRun >= this.options.maxDeployments
      ) {
        break;
      }

      const queued = await this.platform.deployments.findQueued(1);
      if (!queued.ok) {
        // The store is unreachable. Reporting and stopping is right: a worker that cannot read
        // its own queue cannot be trusted to keep deploying.
        return queued;
      }

      const next = queued.value[0];
      if (next === undefined) {
        await this.platform.clock.sleep(millis(this.options.idlePollMillis));
        continue;
      }

      this.log(`running ${next.id} (${next.trigger} → ${next.targetRef})`);
      const finished = await this.platform.engine.run(next);
      deploymentsRun += 1;

      if (!finished.ok) {
        // The engine could not record what happened. Keep going: the next deployment may be
        // fine, and a worker that exits on one bad record takes the platform down with it.
        this.log(`${next.id} could not be recorded: ${finished.error.message}`);
        continue;
      }
      this.log(
        `${next.id} finished as ${finished.value.state}` +
          (finished.value.error === undefined ? "" : ` (${finished.value.error.code})`),
      );
    }

    return ok({ deploymentsRun });
  }
}

/** The idle wait, in the domain's type, so it goes through the clock like every other wait. */
function millis(value: number): Duration {
  return unwrapOrThrow(DurationCodec.fromMillis(value));
}
