/**
 * `HealthProbe` — one request, one answer.
 *
 * The port takes a path and a timeout, not a `HealthCheckSpec`. That is deliberate:
 * handed the spec, an adapter would be one line away from evaluating it, and the
 * platform's most-tuned numbers — how many consecutive passes, over what budget — would
 * end up hidden behind a network boundary where they can only be tested with a mock
 * HTTP server. Thresholds are policy in the application layer; this port reports facts.
 *
 * There is no loop here, no sleep, and no notion of "healthy". A probe that returned a
 * boolean would have made the decision.
 *
 * The target is a union because the platform probes twice for different reasons
 * (`docs/architecture/decisions.md` § D10): the candidate directly, to prove the
 * application works, and then the public route, to prove the routing does. A correct
 * container behind a proxy pointing at a stale port is a complete outage that the first
 * check reports as success.
 */

import type { Duration, Result, UrlPath } from "@/core/shared";
import type { ProxyUpstream, PublicRoute } from "@/core/domain";

/** Where to send the probe. */
export type ProbeTarget =
  /** Straight at a container's internal address, before it serves any traffic. */
  | { readonly kind: "upstream"; readonly upstream: ProxyUpstream }
  /** Through the public route, exercising the proxy as well as the application. */
  | { readonly kind: "route"; readonly route: PublicRoute };

export interface ProbeRequest {
  readonly target: ProbeTarget;
  readonly path: UrlPath;
  /** How long to wait for this single attempt. Not a budget for many. */
  readonly timeout: Duration;
}

/**
 * What happened, without any judgement about what it means.
 *
 * "Did not answer" is a distinct shape from "answered with a status", because a
 * connection refused a millisecond after start and a 500 returned after thirty seconds
 * are different diagnoses that a single status number cannot express.
 */
export type ProbeOutcome =
  | {
      readonly kind: "responded";
      readonly status: number;
      readonly latency: Duration;
      /** A short prefix of the body, for the deployment record. Never the whole page. */
      readonly bodyExcerpt: string;
    }
  | {
      readonly kind: "unreachable";
      readonly latency: Duration;
      /** Why no response arrived: refused, reset, timed out, DNS failure. */
      readonly reason: string;
    };

export interface HealthProbe {
  /**
   * Issue one probe.
   *
   * A failing endpoint is a successful probe: an unreachable target and a 503 are both
   * `Result` successes carrying an outcome. The `Result` fails only when the probe could
   * not be attempted at all.
   */
  probe(request: ProbeRequest): Promise<Result<ProbeOutcome>>;
}
