/**
 * The worker process.
 *
 * The web server queues deployments; this runs them. They are separate processes because a
 * deployment takes minutes and must outlive the request that triggered it — hosting the engine
 * in a request handler would tie its lifetime to a connection and to whatever proxy timeout sits
 * in front of the dashboard (`docs/architecture/decisions.md` § D7).
 *
 * It is deliberately thin. Construct the platform, run the worker loop, and shut down cleanly:
 * every decision it appears to make belongs to the engine.
 *
 * Restarting is the supervisor's job, not this file's. It runs under `--restart unless-stopped`,
 * so an unrecoverable error should exit non-zero and let Docker start a fresh process — which
 * also re-runs the boot sweep, and the boot sweep is what cleans up whatever the dead process
 * left behind.
 */

import { createPlatform, runtimeConfigFromEnv, type Platform } from "@/server/runtime/composition";
import {
  checkRuntime,
  dockerSocketFromEnv,
  formatProblems,
  hintFor,
} from "@/server/runtime/startup-check";
import { DEFAULT_WORKER_OPTIONS, Worker } from "@/server/runtime/worker";

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

async function main(): Promise<number> {
  const config = runtimeConfigFromEnv();

  // Before the database is opened, so an unprepared host is reported as an unprepared host
  // rather than as `ERR_SQLITE_ERROR: unable to open database file` four layers down.
  const options = { dockerSocket: dockerSocketFromEnv() };
  const problems = checkRuntime(config, options);
  if (problems.length > 0) {
    console.error(formatProblems(problems, hintFor(config, options)));
    return 1;
  }

  const platform: Platform = createPlatform(config);
  const worker = new Worker(platform, DEFAULT_WORKER_OPTIONS, log);

  // Finish the deployment in flight, then return. A deployment killed midway leaves a container
  // half-replaced and a lease held, and while the boot sweep can recover from that, not causing
  // it is better than recovering from it. Docker's default 10s stop timeout is not long enough
  // for a build, so the run command sets `--stop-timeout` accordingly.
  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    log(`${signal} received; finishing the current deployment before exiting`);
    worker.stop();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  log(`worker ${platform.workerId} started`);
  try {
    const ran = await worker.run();
    if (!ran.ok) {
      log(`worker stopped: ${ran.error.code} — ${ran.error.message}`);
      return 1;
    }
    log(`worker exiting after ${ran.value.deploymentsRun} deployment(s)`);
    return 0;
  } finally {
    platform.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((cause: unknown) => {
    console.error(cause);
    process.exitCode = 1;
  });
