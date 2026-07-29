/**
 * `HealthProbe` over `fetch`.
 *
 * One request, one result, no interpretation. A 503 and a refused connection are both
 * *successful* probes carrying an outcome the policy will judge; the `Result` fails only when
 * the request could not be attempted.
 *
 * Reaching a candidate directly is possible because DeployHub runs on the target server: the
 * container is published on loopback and probed at `http://127.0.0.1:<allocated port>`. That is
 * the assumption which removes SSH from the MVP, and the first one to break when a second
 * server appears.
 *
 * `PublicRoute` carries a host and a path but no port, so the scheme and port Caddy serves on
 * are configuration here — `http`/`8080` in development, `https`/`443` in production.
 */

import { type Result, Duration, ok, unwrapOrThrow } from "@/core/shared";
import type { HealthProbe, ProbeOutcome, ProbeRequest, ProbeTarget } from "@/core/ports";

export interface HealthProbeOptions {
  /** Scheme Caddy serves the public route on. */
  readonly publicScheme: "http" | "https";
  /** Port Caddy serves the public route on. */
  readonly publicPort: number;
}

const BODY_EXCERPT_LIMIT = 200;

export class FetchHealthProbe implements HealthProbe {
  constructor(private readonly options: HealthProbeOptions) {}

  async probe(request: ProbeRequest): Promise<Result<ProbeOutcome>> {
    const url = this.urlFor(request.target, request.path);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeout.millis);
    timer.unref?.();
    const startedAt = Date.now();

    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        // A health check asks "are you there", not "what did you decide to send me instead".
        redirect: "manual",
        headers: { "User-Agent": "DeployHub/health-check" },
      });
      const body = await response.text();
      return ok({
        kind: "responded",
        status: response.status,
        latency: elapsedSince(startedAt),
        bodyExcerpt: body.slice(0, BODY_EXCERPT_LIMIT),
      });
    } catch (cause) {
      // Refused, reset, DNS failure, and timeout all land here. The reason is kept because it
      // is the difference between "not up yet" and "will never be up".
      return ok({
        kind: "unreachable",
        latency: elapsedSince(startedAt),
        reason: describe(cause, request.timeout.millis),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private urlFor(target: ProbeTarget, path: string): string {
    if (target.kind === "upstream") {
      // Always plain http: the candidate is a container on loopback, and TLS terminates at
      // the proxy in front of it.
      return `http://${target.upstream.host}:${target.upstream.port}${path}`;
    }
    const { publicScheme, publicPort } = this.options;
    const isDefaultPort =
      (publicScheme === "http" && publicPort === 80) ||
      (publicScheme === "https" && publicPort === 443);
    const authority = isDefaultPort ? target.route.host : `${target.route.host}:${publicPort}`;
    return `${publicScheme}://${authority}${path}`;
  }
}

function elapsedSince(startedAt: number): Duration {
  return unwrapOrThrow(Duration.fromMillis(Math.max(0, Date.now() - startedAt)));
}

function describe(cause: unknown, timeoutMillis: number): string {
  if (cause instanceof Error) {
    return cause.name === "AbortError" || cause.name === "TimeoutError"
      ? `no response within ${timeoutMillis}ms`
      : `${cause.name}: ${cause.message}`;
  }
  return String(cause);
}
