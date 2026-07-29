/**
 * Runtime environment validation.
 *
 * `process.env` is validated and normalized once, at module load, and exposed
 * as a typed, immutable `env` object. If any variable is missing or malformed
 * the process throws immediately with an actionable message — DeployHub never
 * boots with invalid configuration.
 *
 * This module has zero external dependencies by design: configuration
 * validation is foundational and should not couple the platform to a schema
 * library. If richer schemas are ever needed elsewhere, this is trivially
 * portable to one (e.g. zod) without changing the public `env` contract.
 */

const NODE_ENVS = ["development", "test", "production"] as const;
type NodeEnv = (typeof NODE_ENVS)[number];

export interface Env {
  readonly NODE_ENV: NodeEnv;
  readonly NEXT_PUBLIC_APP_URL: string;
}

export class EnvValidationError extends Error {
  constructor(issues: readonly string[]) {
    super(`Invalid environment variables:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "EnvValidationError";
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Validate a raw environment source into a typed `Env`. Exported so it can be
 * unit-tested against arbitrary inputs without touching the real process env.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const issues: string[] = [];

  const nodeEnv = source.NODE_ENV ?? "development";
  if (!(NODE_ENVS as readonly string[]).includes(nodeEnv)) {
    issues.push(`NODE_ENV must be one of ${NODE_ENVS.join(" | ")} (received "${nodeEnv}")`);
  }

  const appUrl = source.NEXT_PUBLIC_APP_URL?.trim();
  if (!appUrl) {
    issues.push("NEXT_PUBLIC_APP_URL is required");
  } else if (!isHttpUrl(appUrl)) {
    issues.push(`NEXT_PUBLIC_APP_URL must be a valid http(s) URL (received "${appUrl}")`);
  }

  if (issues.length > 0) {
    throw new EnvValidationError(issues);
  }

  return Object.freeze({
    NODE_ENV: nodeEnv as NodeEnv,
    NEXT_PUBLIC_APP_URL: appUrl as string,
  });
}

export const env: Env = parseEnv(process.env);
