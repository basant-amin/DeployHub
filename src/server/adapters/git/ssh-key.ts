/**
 * The private key on disk, for as short a time as possible.
 *
 * `ssh` will not take a key from an environment variable or a file descriptor it did not open, so
 * an SSH deployment means writing the key to a file. That is the one new risk this feature
 * introduces, and everything in this module exists to bound it:
 *
 * - **Outside the workspace.** `workspaceFor()` is what `docker build` streams as its build
 *   context, so a key written there could end up in an image layer. These directories live under
 *   the process's temp directory, which no build ever reads.
 * - **`0700` directory, `0600` file**, and the mode is set explicitly after creation rather than
 *   trusted to the umask.
 * - **Removed in a `finally`**, so a failed fetch cleans up as reliably as a successful one.
 * - **Never in argv.** `GIT_SSH_COMMAND` carries `-i <path>`; the path is not the key, and the
 *   command runner logs argv but never the environment.
 * - **Swept at boot**, because a process killed with `SIGKILL` never runs its `finally`.
 *
 * Host-key verification is always on. `StrictHostKeyChecking=yes` with a `UserKnownHostsFile` this
 * module writes, `IdentitiesOnly=yes` so ssh cannot substitute some other key it found, and
 * `IdentityAgent=none` so it cannot reach an agent. None of the three is configurable.
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { type Result, DeploymentError, err, ok } from "@/core/shared";

import { knownHostsFileContents } from "./known-hosts";

const DIR_MODE = 0o700;
const KEY_MODE = 0o600;

/** One directory DeployHub owns, so the sweep has an exact scope rather than a pattern to guess. */
const BASE_DIRECTORY_NAME = "deployhub-git-auth";

/**
 * `session-<pid>-<random>`.
 *
 * The pid is in the name so the sweep can ask whether the process that created a directory is still
 * running. Without it the sweep would have to guess from timestamps, and would eventually delete
 * the key of a deployment that was still using it.
 */
const SESSION_PREFIX = "session-";
const SESSION_NAME = /^session-(\d+)-[A-Za-z0-9]+$/;

export interface SshIdentity {
  /** Value for `GIT_SSH_COMMAND`. Contains paths, never key material. */
  readonly sshCommand: string;
  /** Remove the directory and everything in it. Idempotent. */
  readonly dispose: () => void;
}

/** The directory session directories are created in. Created on demand, `0700`. */
export function authBaseDirectory(base: string = tmpdir()): string {
  return join(base, BASE_DIRECTORY_NAME);
}

/**
 * Reject anything that is not an OpenSSH or PEM private key before a deployment starts.
 *
 * Cheap, and it turns "Load key: error in libcrypto" — which arrives from `ssh` two layers down and
 * reads like a platform fault — into a message naming the secret entry that needs fixing.
 *
 * Deliberately a shape check, not a parse. Whether the key is *valid* is `ssh`'s judgement and
 * whether it is *authorized* is GitHub's; this only catches the entry holding something that is
 * plainly not a key at all, which is the mistake an operator actually makes.
 */
export function looksLikePrivateKey(material: string): boolean {
  const trimmed = material.trim();
  return (
    /^-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(trimmed) &&
    /-----END (?:[A-Z ]+ )?PRIVATE KEY-----$/.test(trimmed)
  );
}

/**
 * Write the key and the host keys, and return the ssh command git should use.
 *
 * The caller must call `dispose()` in a `finally`.
 */
export function createSshIdentity(
  privateKey: string,
  knownHosts: string | undefined,
  base: string = tmpdir(),
): Result<SshIdentity> {
  if (!looksLikePrivateKey(privateKey)) {
    return err(
      DeploymentError.of(
        "PREFLIGHT_CREDENTIAL_MISSING",
        "The git credential for this project is not an SSH private key. A project using ssh-deploy-key needs the private half of a deploy key in its secret entry — generate one with `npm run git:keygen`.",
        { details: {} },
      ),
    );
  }

  let directory: string;
  try {
    const root = authBaseDirectory(base);
    mkdirSync(root, { recursive: true, mode: DIR_MODE });
    chmodSync(root, DIR_MODE);
    directory = mkdtempSync(join(root, `${SESSION_PREFIX}${process.pid}-`));
    chmodSync(directory, DIR_MODE);
  } catch (cause) {
    return err(
      DeploymentError.of(
        "SECRET_STORE_UNAVAILABLE",
        `Cannot create a private directory for the deploy key: ${messageOf(cause)}`,
        { details: {} },
      ),
    );
  }

  const dispose = (): void => {
    rmSync(directory, { recursive: true, force: true });
  };

  try {
    const keyPath = join(directory, "id");
    const knownHostsPath = join(directory, "known_hosts");

    // The key is written before its mode is narrowed, so it exists briefly at whatever the umask
    // allows. The enclosing directory is already 0700, which is what actually keeps it private —
    // the file mode is the second line of defence rather than the first.
    writeFileSync(keyPath, ensureTrailingNewline(privateKey), { mode: KEY_MODE });
    chmodSync(keyPath, KEY_MODE);
    writeFileSync(knownHostsPath, knownHostsFileContents(knownHosts), { mode: KEY_MODE });

    return ok({ sshCommand: sshCommandFor(keyPath, knownHostsPath), dispose });
  } catch (cause) {
    dispose();
    return err(
      DeploymentError.of(
        "SECRET_STORE_UNAVAILABLE",
        `Cannot write the deploy key: ${messageOf(cause)}`,
        { details: {} },
      ),
    );
  }
}

/**
 * The ssh invocation, as one shell word list git will pass to `sh -c`.
 *
 * Paths are quoted because the temp directory is not under this module's control, and `-F /dev/null`
 * discards any `ssh_config` on the host: a deployment must not depend on configuration that happens
 * to be in the image, and an `IdentityFile` or `StrictHostKeyChecking no` inherited from a config
 * file would quietly undo everything above.
 */
function sshCommandFor(keyPath: string, knownHostsPath: string): string {
  return [
    "ssh",
    "-F /dev/null",
    `-i '${keyPath}'`,
    "-o IdentitiesOnly=yes",
    "-o IdentityAgent=none",
    "-o StrictHostKeyChecking=yes",
    `-o UserKnownHostsFile='${knownHostsPath}'`,
    "-o PasswordAuthentication=no",
    "-o BatchMode=yes",
  ].join(" ");
}

export interface SweepResult {
  readonly removed: readonly string[];
  /** Kept because the process that owns them is still running. */
  readonly live: number;
}

/**
 * Remove key directories left behind by a process that is gone.
 *
 * A worker killed with `SIGKILL` — an OOM kill, a `docker kill`, a host reset — never runs its
 * `finally`, and a private key must not sit in the container's writable layer until someone
 * notices. This runs at worker startup, where the same reasoning already justifies the boot sweep.
 *
 * Five conditions, **all** required before anything is removed. Each one alone would be a thin
 * guarantee; together they mean this can only ever delete a directory this module created:
 *
 * 1. the entry is a **direct child** of the resolved base directory
 * 2. its name matches `session-<pid>-<random>` exactly
 * 3. `lstat` says directory and **not a symlink** — so a planted link cannot redirect the delete
 * 4. it is owned by **this uid**
 * 5. the pid encoded in the name is **not running** — which is what makes a second worker safe
 *
 * Never throws. A sweep that fails must not stop a worker from starting; the cost of a missed
 * directory is one stale key, and the cost of refusing to boot is the platform being unusable.
 */
export function sweepStaleSshIdentities(base: string = tmpdir()): SweepResult {
  const root = authBaseDirectory(base);
  const removed: string[] = [];
  let live = 0;

  let entries: readonly string[];
  try {
    if (!existsSync(root)) {
      return { removed, live };
    }
    entries = readdirSync(root);
  } catch {
    return { removed, live };
  }

  const resolvedRoot = resolve(root);
  const uid = process.getuid?.();

  for (const name of entries) {
    const match = SESSION_NAME.exec(name);
    if (match === null) {
      continue;
    }

    const path = join(resolvedRoot, name);
    // Belt and braces: `readdir` cannot return a name containing a separator, but this is the
    // check that makes "direct child of the base directory" true by construction rather than by
    // reasoning about readdir.
    if (resolve(path) !== join(resolvedRoot, name)) {
      continue;
    }

    try {
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        continue;
      }
      if (uid !== undefined && info.uid !== uid) {
        continue;
      }
      if (isRunning(Number(match[1]))) {
        live += 1;
        continue;
      }
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // An entry that cannot be inspected is left alone. Guessing is how a sweep becomes a bug.
      continue;
    }
  }

  return { removed, live };
}

/**
 * Whether a pid is alive.
 *
 * Signal 0 performs the permission and existence checks without delivering anything. `EPERM` means
 * the process exists and belongs to someone else, which is still alive — and still a reason not to
 * touch its directory, even though condition 4 would already have excluded it.
 */
function isRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

function ensureTrailingNewline(text: string): string {
  // OpenSSH rejects a key whose final line is unterminated with "invalid format", and a key pasted
  // into JSON very often loses it.
  return text.endsWith("\n") ? text : `${text}\n`;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
