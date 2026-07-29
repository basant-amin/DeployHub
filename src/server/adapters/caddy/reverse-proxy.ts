/**
 * `ReverseProxy` over the Caddy admin API.
 *
 * Three HTTP calls, verified against a real Caddy — see `docs/ops/host-spike.md`. No config
 * file templating, no reload command, no `caddy` binary invoked at runtime. Caddy validates
 * and applies a change atomically, and a rejected change leaves the previous routing intact:
 * that is the property the rollback path depends on, and it is why this adapter is
 * dramatically less risky than generating and reloading an nginx config.
 *
 * The mechanism is Caddy's `@id`. Each project's reverse-proxy handler carries
 * `@id: deployhub-upstream-<slug>`, which makes it addressable at `/id/<that>`:
 *
 * - `GET  /id/deployhub-upstream-<slug>` → the current upstream, or a 404-with-body when the
 *   route does not exist yet, which is how "no previous release" is distinguished from "cannot
 *   reach Caddy".
 * - `PATCH /id/deployhub-upstream-<slug>` → switch, with no reload and no dropped connections.
 * - `POST /config/apps/http/servers/<server>/routes` → create the route on first deployment.
 */

import { type Result, DeploymentError, err, ok } from "@/core/shared";
import { type PublicRoute, ProxyUpstream } from "@/core/domain";
import type { ReverseProxy } from "@/core/ports";

export interface CaddyAdapterOptions {
  /** Caddy's admin endpoint. Defaults to what Caddy listens on out of the box. */
  readonly adminUrl: string;
  /** The server key inside `apps.http.servers` that DeployHub adds routes to. */
  readonly serverName: string;
  readonly timeoutMillis: number;
}

interface ReverseProxyHandler {
  readonly "@id": string;
  readonly handler: "reverse_proxy";
  readonly upstreams: readonly { readonly dial: string }[];
}

export class CaddyReverseProxy implements ReverseProxy {
  constructor(private readonly options: CaddyAdapterOptions) {}

  async readUpstream(route: PublicRoute): Promise<Result<ProxyUpstream | undefined>> {
    const response = await this.call("GET", `/id/${this.handlerId(route)}`);
    if (!response.ok) {
      return response;
    }
    if (response.value.status === 404 || isUnknownId(response.value.body)) {
      // The route has never been created — this project has no live release.
      return ok(undefined);
    }
    if (response.value.status !== 200) {
      return err(this.unexpected(response.value));
    }

    let handler: ReverseProxyHandler;
    try {
      handler = JSON.parse(response.value.body) as ReverseProxyHandler;
    } catch {
      return err(
        DeploymentError.of("PROXY_UNAVAILABLE", "Caddy did not return JSON for the current route"),
      );
    }

    const dial = handler.upstreams?.[0]?.dial;
    if (typeof dial !== "string") {
      return ok(undefined);
    }
    return parseDial(dial);
  }

  /**
   * Point the route at `upstream`.
   *
   * Patches the handler when the route exists and creates the route when it does not, because
   * from the engine's point of view "make this route serve that container" is one operation
   * and the difference between the first deployment and the rest is not its business.
   */
  async pointRouteAt(route: PublicRoute, upstream: ProxyUpstream): Promise<Result<void>> {
    const handler: ReverseProxyHandler = {
      "@id": this.handlerId(route),
      handler: "reverse_proxy",
      upstreams: [{ dial: `${upstream.host}:${upstream.port}` }],
    };

    const patched = await this.call("PATCH", `/id/${this.handlerId(route)}`, handler);
    if (!patched.ok) {
      return patched;
    }
    if (patched.value.status === 200) {
      return ok(undefined);
    }
    if (patched.value.status !== 404 && !isUnknownId(patched.value.body)) {
      return err(this.unexpected(patched.value));
    }

    return this.createRoute(route, handler);
  }

  private async createRoute(
    route: PublicRoute,
    handler: ReverseProxyHandler,
  ): Promise<Result<void>> {
    const created = await this.call(
      "POST",
      `/config/apps/http/servers/${this.options.serverName}/routes`,
      {
        "@id": `deployhub-route-${route.host}`,
        match: [{ host: [route.host] }],
        handle: [handler],
      },
    );
    if (!created.ok) {
      return created;
    }
    return created.value.status === 200 ? ok(undefined) : err(this.unexpected(created.value));
  }

  /**
   * Addressed by host rather than by project slug.
   *
   * A route is a host in Caddy's model, and two projects cannot serve the same host — so the
   * host is the identity that cannot collide, and using the slug would let a renamed project
   * orphan its own route.
   */
  private handlerId(route: PublicRoute): string {
    return `deployhub-upstream-${route.host}`;
  }

  private async call(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<Result<{ readonly status: number; readonly body: string }>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMillis);
    timer.unref?.();
    try {
      const response = await fetch(`${this.options.adminUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          // Caddy's admin API enforces origin safety and refuses a request whose `Origin` is
          // present but not an allowed one. `fetch` sends an empty `Origin`, which reads as
          // untrusted and returns 403 — where curl, sending none at all, is allowed. Verified:
          // `docs/ops/host-spike.md`.
          Origin: this.options.adminUrl,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return ok({ status: response.status, body: await response.text() });
    } catch (cause) {
      return err(
        DeploymentError.of(
          "PROXY_UNAVAILABLE",
          `Caddy admin API at ${this.options.adminUrl} did not answer: ${cause instanceof Error ? cause.message : String(cause)}`,
          { details: { adminUrl: this.options.adminUrl, path } },
        ),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private unexpected(response: {
    readonly status: number;
    readonly body: string;
  }): DeploymentError {
    return DeploymentError.of(
      "PROXY_RELOAD_FAILED",
      `Caddy refused the change (${response.status}): ${response.body.slice(0, 400)}`,
      { details: { status: response.status } },
    );
  }
}

/** Caddy answers a missing `@id` with a body naming it; the status alone is not enough. */
function isUnknownId(body: string): boolean {
  return body.includes("unknown object ID");
}

function parseDial(dial: string): Result<ProxyUpstream | undefined> {
  const separator = dial.lastIndexOf(":");
  if (separator <= 0) {
    return ok(undefined);
  }
  const upstream = ProxyUpstream.create({
    host: dial.slice(0, separator),
    port: Number(dial.slice(separator + 1)),
  });
  // A dial string this platform did not write is reported as "nothing recognisable is live"
  // rather than as a failure, so a hand-edited Caddy config does not wedge the platform.
  return upstream.ok ? ok(upstream.value) : ok(undefined);
}
