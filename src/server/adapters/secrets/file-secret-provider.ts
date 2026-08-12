/**
 * `SecretProvider` backed by one JSON file with 0600 permissions.
 *
 * That is the whole design, and it is the right amount of machinery for a single-server
 * internal platform: the secrets are readable by the user the worker runs as and by root, and
 * by nobody else. A vault is a later problem with a later port implementation.
 *
 * The file is re-read on every resolve rather than cached. Rotating a credential should mean
 * changing an entry, not restarting a worker, and a deployment reads each secret once.
 *
 * **Read-only at runtime.** There is no write path here, which is why the dashboard collects secret
 * *references* and never secret values, and why nothing reachable from a server action can write a
 * credential. The one writer is `secret-file-writer.ts`, used by the `git:keygen` operator command
 * and imported by nothing else — so the invariant is "no runtime write path, one operator writer"
 * rather than "nothing can write".
 *
 * Shape:
 *
 * ```json
 * {
 *   "one-community.git.credentials": "ghp_…",
 *   "one-community.runtime.env": { "DATABASE_URL": "postgres://…", "PORT": "3000" }
 * }
 * ```
 *
 * A string resolves as a credential; an object resolves as an environment. Nothing else is
 * accepted, because a secret whose shape is ambiguous is a secret that will be used wrongly.
 */

import { readFile, stat } from "node:fs/promises";

import { type Result, type SecretRef, DeploymentError, err, ok } from "@/core/shared";
import type { SecretProvider } from "@/core/ports";

export class FileSecretProvider implements SecretProvider {
  constructor(private readonly path: string) {}

  async exists(ref: SecretRef): Promise<Result<boolean>> {
    const store = await this.load();
    return store.ok ? ok(store.value[ref] !== undefined) : store;
  }

  async resolveCredential(ref: SecretRef): Promise<Result<string>> {
    const store = await this.load();
    if (!store.ok) {
      return store;
    }
    const value = store.value[ref];
    if (typeof value === "string" && value.length > 0) {
      return ok(value);
    }
    return err(
      DeploymentError.of(
        "PREFLIGHT_CREDENTIAL_MISSING",
        value === undefined
          ? `Secret "${ref}" is not in the secret file`
          : `Secret "${ref}" is not a credential string`,
        { details: { ref } },
      ),
    );
  }

  async resolveEnvironment(ref: SecretRef): Promise<Result<ReadonlyMap<string, string>>> {
    const store = await this.load();
    if (!store.ok) {
      return store;
    }
    const value = store.value[ref];
    if (
      value === undefined ||
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    ) {
      return err(
        DeploymentError.of(
          "PREFLIGHT_CREDENTIAL_MISSING",
          value === undefined
            ? `Secret "${ref}" is not in the secret file`
            : `Secret "${ref}" is not an environment object`,
          { details: { ref } },
        ),
      );
    }

    const environment = new Map<string, string>();
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry !== "string") {
        return err(
          DeploymentError.of(
            "PREFLIGHT_CREDENTIAL_MISSING",
            `Environment variable "${key}" in secret "${ref}" is not a string`,
            { details: { ref, key } },
          ),
        );
      }
      environment.set(key, entry);
    }
    return ok(environment);
  }

  /**
   * Read and parse the store, refusing a file the wrong people can read.
   *
   * The permission check is not decoration. A secret file that is world-readable is not a
   * secret file, and failing loudly at the first deployment is far better than discovering it
   * during an incident review.
   */
  private async load(): Promise<Result<Record<string, unknown>>> {
    let raw: string;
    try {
      const info = await stat(this.path);
      const mode = info.mode & 0o777;
      if ((mode & 0o077) !== 0) {
        return err(
          DeploymentError.of(
            "SECRET_STORE_UNAVAILABLE",
            `${this.path} is mode ${mode.toString(8)}; it must be 0600 so only the owner can read it`,
            { details: { path: this.path, mode: mode.toString(8) } },
          ),
        );
      }
      raw = await readFile(this.path, "utf8");
    } catch (cause) {
      return err(
        DeploymentError.of(
          "SECRET_STORE_UNAVAILABLE",
          `Cannot read the secret file at ${this.path}: ${cause instanceof Error ? cause.message : String(cause)}`,
          { details: { path: this.path } },
        ),
      );
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return err(
          DeploymentError.of(
            "SECRET_STORE_UNAVAILABLE",
            `${this.path} must contain a JSON object of secret references`,
          ),
        );
      }
      return ok(parsed as Record<string, unknown>);
    } catch {
      // Deliberately not including the parse error: it can quote file content.
      return err(DeploymentError.of("SECRET_STORE_UNAVAILABLE", `${this.path} is not valid JSON`));
    }
  }
}
