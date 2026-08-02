/**
 * Next's server boot hook — where the web process checks the host before serving anything.
 *
 * `register()` runs once, when the server starts, before the first request. That timing is the
 * entire point of this file. `getPlatform()` is lazy, so without a check here the web container
 * boots happily on a host it cannot use: Next reports ready, `/signin` returns 200, the container
 * is `running`, `--restart unless-stopped` never fires, and the failure waits until someone opens
 * the dashboard. That is exactly what happened on the first production install, and a container
 * that is broken must say so at startup rather than look healthy until it is needed.
 *
 * The worker does the same check in `scripts/worker.ts`. Both, rather than one shared place,
 * because they are separate processes with separate lifecycles — and because the whole failure
 * being fixed here is one process discovering a problem the other had already hit.
 */

export async function register(): Promise<void> {
  // `register` also runs in the edge runtime, which has no filesystem and no Docker socket to
  // check. The work lives behind a dynamic import so the edge bundle never contains Node's
  // `fs`, `net`, or `process.exit` at all — a runtime guard alone would still pull them in.
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { abortUnlessRuntimeReady } = await import("@/server/runtime/boot");
  abortUnlessRuntimeReady();
}
