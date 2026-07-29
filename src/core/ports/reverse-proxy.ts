/**
 * `ReverseProxy` — decide which container a public route reaches.
 *
 * Two methods, and the asymmetry between them is the point. Reading the current
 * upstream is what makes a baseline capturable and a crash recoverable: the running
 * proxy is authoritative, so the platform must be able to *ask* what a route currently
 * serves rather than assume it matches a record. Pointing a route at an upstream is the
 * single irreversible-ish act in a deployment, and it is one call so that undoing it is
 * also one call.
 *
 * Validating the rendered configuration before applying it, and reloading rather than
 * restarting so in-flight connections drain, are obligations of the adapter, not
 * choices for the engine. They are not separate methods because there is no legitimate
 * reason to apply a configuration without validating it first.
 *
 * Weighted upstreams — canary and percentage traffic — are a named extension point that
 * adds a method here. Release 1 switches all traffic at once.
 */

import type { Result } from "@/core/shared";
import type { ProxyUpstream, PublicRoute } from "@/core/domain";

export interface ReverseProxy {
  /**
   * Where a route currently sends traffic, or `undefined` if it is not configured.
   *
   * Read from the live proxy, not from a cache: a value the platform remembers is a
   * value that can be wrong at exactly the moment it matters.
   */
  readUpstream(route: PublicRoute): Promise<Result<ProxyUpstream | undefined>>;

  /**
   * Send the route's traffic to `upstream`, atomically from a client's perspective.
   *
   * Implementations must validate the configuration before applying it and reload
   * without dropping in-flight connections. A failure must leave the previous routing
   * intact — a half-applied switch is the one outcome the engine cannot compensate for.
   */
  pointRouteAt(route: PublicRoute, upstream: ProxyUpstream): Promise<Result<void>>;
}
