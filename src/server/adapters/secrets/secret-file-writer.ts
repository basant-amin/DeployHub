/**
 * The one writer of the secret store.
 *
 * `FileSecretProvider` is read-only, and that is a property worth keeping rather than an omission:
 * it is why the dashboard collects secret *references* and never secret values, and why nothing
 * reachable from a server action can write a credential. So this is not a method on that class and
 * not on the `SecretProvider` port — it is a separate module used by one operator CLI
 * (`scripts/git-keygen.ts`), which nothing in the web process imports.
 *
 * The invariant becomes precise rather than weaker: **no runtime write path; one operator writer.**
 *
 * Writing is atomic. A temp file in the same directory, then `rename`, which is atomic on the same
 * filesystem — so a crash halfway cannot leave a truncated store. That matters more here than in
 * most places: the store is the only copy of every project's credentials, there is no backup, and a
 * corrupted store fails every deployment at preflight.
 */

import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { statSync } from "node:fs";

import {
  type Result,
  type SecretRef,
  DeploymentError,
  SecretRef as SecretRefCodec,
  err,
  ok,
} from "@/core/shared";

const REQUIRED_MODE = 0o600;

export interface WriteOptions {
  /** Replace an entry that already exists. Without it, an existing ref is refused. */
  readonly force?: boolean;
}

export interface WriteReport {
  readonly ref: SecretRef;
  /** Whether an existing value was replaced, so the caller can say which happened. */
  readonly replaced: boolean;
}

/**
 * Put one credential in the store, leaving every other entry untouched.
 *
 * Refusing an existing ref by default is the important behaviour. Overwriting a deploy key means the
 * public half registered on GitHub no longer matches anything, and every deployment of that project
 * fails until someone notices — so replacing one has to be a decision, not a typo.
 *
 * No backup copy is kept when replacing. A second private key at rest is a worse risk than the
 * rotation window, and GitHub allows adding the new deploy key before removing the old one, so the
 * window can be closed to zero without this file holding two keys.
 */
export function writeCredential(
  storePath: string,
  rawRef: unknown,
  value: string,
  options: WriteOptions = {},
): Result<WriteReport> {
  const ref = SecretRefCodec.parse(rawRef);
  if (!ref.ok) {
    return ref;
  }

  if (value.trim() === "") {
    return err(
      DeploymentError.of("SECRET_STORE_UNAVAILABLE", "Refusing to store an empty credential", {
        details: { ref: ref.value },
      }),
    );
  }

  const store = readStore(storePath);
  if (!store.ok) {
    return store;
  }

  const existing = store.value[ref.value];
  if (existing !== undefined && options.force !== true) {
    return err(
      DeploymentError.of(
        "SECRET_STORE_UNAVAILABLE",
        `"${ref.value}" already has a value in ${storePath}. Replacing a deploy key invalidates the public key registered on the repository, so pass --force if that is what you intend.`,
        { details: { ref: ref.value } },
      ),
    );
  }

  // Key order is preserved for an update and the new key is appended for an insert, so a diff of
  // the store shows one line rather than a reordering.
  const next = { ...store.value, [ref.value]: value };
  const written = writeAtomically(storePath, `${JSON.stringify(next, null, 2)}\n`);
  if (!written.ok) {
    return written;
  }

  return ok({ ref: ref.value, replaced: existing !== undefined });
}

/** Whether the store already holds this ref. Used to report before overwriting. */
export function hasCredential(storePath: string, ref: SecretRef): Result<boolean> {
  const store = readStore(storePath);
  return store.ok ? ok(store.value[ref] !== undefined) : store;
}

/**
 * Read the store, enforcing the same `0600` rule `FileSecretProvider` enforces.
 *
 * The file must already exist. It is created by `docs/ops/install.sh` on a server and
 * `npm run dev:prepare` locally, both of which set the owner and mode deliberately — creating it
 * here would mean guessing at both, and a secret file with the wrong owner is the failure the
 * startup check exists to report.
 */
function readStore(storePath: string): Result<Record<string, unknown>> {
  let raw: string;
  try {
    const mode = statSync(storePath).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      return err(
        DeploymentError.of(
          "SECRET_STORE_UNAVAILABLE",
          `${storePath} is mode ${mode.toString(8)}; it must be 0600 so only the owner can read it`,
          { details: { path: storePath } },
        ),
      );
    }
    raw = readFileSync(storePath, "utf8");
  } catch (cause) {
    return err(
      DeploymentError.of(
        "SECRET_STORE_UNAVAILABLE",
        `Cannot read the secret file at ${storePath}: ${messageOf(cause)}. It is created by docs/ops/install.sh on a server, or npm run dev:prepare locally.`,
        { details: { path: storePath } },
      ),
    );
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return err(
        DeploymentError.of(
          "SECRET_STORE_UNAVAILABLE",
          `${storePath} must contain a JSON object of secret references`,
          { details: { path: storePath } },
        ),
      );
    }
    return ok(parsed as Record<string, unknown>);
  } catch {
    // Deliberately not including the parse error: it can quote file content, and this file's
    // content is secrets.
    return err(
      DeploymentError.of("SECRET_STORE_UNAVAILABLE", `${storePath} is not valid JSON`, {
        details: { path: storePath },
      }),
    );
  }
}

function writeAtomically(storePath: string, contents: string): Result<void> {
  // Same directory, so `rename` stays within one filesystem and is therefore atomic. A temp file in
  // /tmp would make this a copy, which is not.
  const temporary = join(dirname(storePath), `.${process.pid}.secrets.tmp`);
  try {
    writeFileSync(temporary, contents, { mode: REQUIRED_MODE });
    chmodSync(temporary, REQUIRED_MODE);
    renameSync(temporary, storePath);
    // `rename` carries the temp file's mode, which was set above — but the store may have had a
    // stricter mode still, and being explicit costs nothing.
    chmodSync(storePath, REQUIRED_MODE);
    return ok(undefined);
  } catch (cause) {
    try {
      unlinkSync(temporary);
    } catch {
      // Nothing useful to do: the write already failed, and the temp file holds the same secret the
      // store does. Reported through the error below rather than swallowed silently.
    }
    return err(
      DeploymentError.of(
        "SECRET_STORE_UNAVAILABLE",
        `Cannot write ${storePath}: ${messageOf(cause)}`,
        { details: { path: storePath } },
      ),
    );
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
