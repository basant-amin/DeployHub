/**
 * Boot: check the host, or stop.
 *
 * Separate from `startup-check.ts` because that module only *reports* — it is pure enough to
 * test against temp directories — and separate from `instrumentation.ts` because Next compiles
 * that file for the edge runtime as well, where `process.exit` does not exist. Keeping the exit
 * here means the edge bundle never contains it, and the runtime guard in `instrumentation.ts`
 * does not have to argue with a static analyzer.
 */

import { runtimeConfigFromEnv } from "./composition";
import { checkRuntime, dockerSocketFromEnv, formatProblems } from "./startup-check";

/**
 * Verify the host and terminate the process if it is not usable.
 *
 * Exits rather than throws. Next catches what `register()` throws and carries on serving, which
 * would leave the container in exactly the false-green state this check exists to prevent: ready,
 * answering `/signin`, reporting healthy, and unable to open its database. A non-zero exit is
 * also what `--restart unless-stopped` needs in order to keep retrying while someone fixes the
 * host — and what makes the problem visible in `docker ps` rather than only in a browser.
 */
export function abortUnlessRuntimeReady(): void {
  const problems = checkRuntime(runtimeConfigFromEnv(), {
    dockerSocket: dockerSocketFromEnv(),
  });
  if (problems.length === 0) {
    return;
  }

  console.error(formatProblems(problems));
  process.exit(1);
}
