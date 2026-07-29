/**
 * `PublicRoute` — the address users reach the deployed application at.
 *
 * Host and path are separate fields, not one string, because the reverse proxy
 * treats them differently: the host selects a server block, the path selects a
 * location within it. Storing them pre-split means no adapter has to re-parse a
 * route, and no two adapters can parse it differently.
 */

import { type Result, Hostname, UrlPath, asRecord, combineFields, ok } from "@/core/shared";

export class PublicRoute {
  private constructor(
    readonly host: Hostname,
    readonly path: UrlPath,
  ) {}

  /** Accepts `unknown`, like every other composite, so a bad shape reports itself. */
  static create(raw: unknown): Result<PublicRoute> {
    const record = asRecord(raw, "PUBLIC_ROUTE_INVALID", "Public route");
    if (!record.ok) {
      return record;
    }

    const fields = combineFields("PUBLIC_ROUTE_INVALID", "Invalid public route", {
      host: Hostname.parse(record.value.host),
      // Defaults to `/` — the common case is a whole host serving one application.
      path: UrlPath.parse(record.value.path ?? "/"),
    });
    return fields.ok ? ok(new PublicRoute(fields.value.host, fields.value.path)) : fields;
  }

  /** Whether this route covers the whole host rather than a subtree of it. */
  get isHostRoot(): boolean {
    return this.path === "/";
  }

  toString(): string {
    return this.isHostRoot ? this.host : `${this.host}${this.path}`;
  }

  toJSON(): { readonly host: string; readonly path: string } {
    return { host: this.host, path: this.path };
  }
}
