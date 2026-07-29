import "server-only";

/**
 * The one `Platform` instance the web process uses.
 *
 * Cached on `globalThis` rather than in a module variable because Next's dev server re-evaluates
 * modules on every edit, and a fresh `createPlatform` per edit would open a new SQLite handle
 * each time until the process ran out of them.
 *
 * The worker is a **separate process** with its own instance. They share the database file, which
 * is why it runs in WAL mode: one writer and several readers coexist without blocking.
 */

import { type Platform, createPlatform, runtimeConfigFromEnv } from "./composition";

const CACHE_KEY = Symbol.for("deployhub.platform");

type Cache = { [CACHE_KEY]?: Platform };

export function getPlatform(): Platform {
  const cache = globalThis as unknown as Cache;
  cache[CACHE_KEY] ??= createPlatform(runtimeConfigFromEnv());
  return cache[CACHE_KEY];
}
