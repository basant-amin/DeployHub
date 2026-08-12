/**
 * The developer's local runtime root, and the env file that records it.
 *
 * `npm run dev` is a first-class mode, and the startup check
 * (`src/server/runtime/startup-check.ts`) applies to it exactly as it applies to the containers —
 * deliberately, because a guard that is switched off on the machine where the code is written is a
 * guard that has never been exercised. So local development does not bypass the check; it satisfies
 * it, against a root the developer owns.
 *
 * That root lives **outside the working tree**, under the home directory, because it accumulates
 * real runtime state: a SQLite database with its WAL sidecars, git checkouts of every project, and
 * a secrets file. None of that is source, none of it should be reachable by a `git clean`, and a
 * secrets file inside a repository is one `.gitignore` edit away from being committed.
 *
 * Production is untouched: the image sets `DEPLOYHUB_ROOT=/var/lib/deployhub` and
 * `docs/ops/install.sh` prepares it. This module is the macOS/Linux-developer counterpart of that
 * script, and the differences are the point — it needs no `sudo`, chowns nothing, and uses the
 * uid of whoever runs it rather than the container's 1000.
 */

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";

/** Directory name under the home directory. Not configurable: `DEPLOYHUB_ROOT` already is. */
export const DEV_ROOT_NAME = ".deployhub-dev";

/** The env file Next loads last and git ignores, so it is the one local configuration lives in. */
export const DEV_ENV_FILE = ".env.local";

const DIR_MODE = 0o700;
const SECRETS_MODE = 0o600;

/**
 * Paths this must never prepare.
 *
 * A local bootstrap that can be pointed at a system directory is a local bootstrap that will
 * eventually create `/var/lib/deployhub` on someone's laptop with the wrong owner — which is the
 * production failure the startup check was written for, reproduced by the tool meant to avoid it.
 * System roots belong to `docs/ops/install.sh`, which asks for `sudo` and says why.
 */
const RESERVED_PREFIXES = [
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib32",
  "/lib64",
  "/opt",
  "/proc",
  "/sbin",
  "/srv",
  "/sys",
  "/usr",
  "/var/lib",
  "/var/log",
  "/var/run",
  "/Library",
  "/System",
] as const;

export class DevSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevSetupError";
  }
}

/** Where a developer's runtime state goes unless `DEPLOYHUB_ROOT` says otherwise. */
export function defaultDevRoot(home: string = homedir()): string {
  return join(home, DEV_ROOT_NAME);
}

/** A local shared password, in the form `docs/docker.md` recommends (`openssl rand -hex 24`). */
export function generateLocalPassword(): string {
  return randomBytes(24).toString("hex");
}

export interface PrepareReport {
  readonly root: string;
  /** What was created or corrected, in words an operator can check. */
  readonly changed: readonly string[];
  /** What was already right. Reported so a re-run visibly does nothing. */
  readonly already: readonly string[];
}

/**
 * Create the three paths the startup check requires, owned by the current user.
 *
 * Idempotent, and never destructive: an existing `secrets.json` is left exactly as it is, because
 * it holds real credentials and there is no write path in the platform to recreate them from.
 */
export function prepareDevRoot(
  root: string,
  options: { readonly uid?: number | undefined } = {},
): PrepareReport {
  assertUsableRoot(root, options.uid ?? process.getuid?.() ?? 0);

  const changed: string[] = [];
  const already: string[] = [];

  ensureDirectory(root, changed, already);
  ensureDirectory(join(root, "projects"), changed, already);
  ensureSecretsFile(join(root, "secrets.json"), changed, already);

  return { root, changed, already };
}

export interface EnvFileReport {
  readonly path: string;
  readonly created: boolean;
  /** Names of the variables written. Values are never reported — one of them is a password. */
  readonly added: readonly string[];
  readonly already: readonly string[];
}

/**
 * Make sure the env file names the prepared root and a password.
 *
 * `DEPLOYHUB_ROOT` has to be in the file rather than only in this script's head: the dev server,
 * the worker, and the CLI are separate processes, and only the env file is read by all three.
 *
 * Existing lines are never rewritten. A developer who has set their own root or password keeps it,
 * and the only edit this makes to a file that already exists is to append what is missing.
 */
export function ensureDevEnvFile(
  path: string,
  root: string,
  generatePassword: () => string = generateLocalPassword,
): EnvFileReport {
  if (!existsSync(path)) {
    writeFileSync(path, template(root, generatePassword()), { mode: SECRETS_MODE });
    chmodSync(path, SECRETS_MODE);
    return { path, created: true, added: ["DEPLOYHUB_ROOT", "DEPLOYHUB_PASSWORD"], already: [] };
  }

  const contents = readFileSync(path, "utf8");
  const added: string[] = [];
  const already: string[] = [];
  let appended = "";

  if (readEnvValue(contents, "DEPLOYHUB_ROOT") === undefined) {
    appended += `\n# Added by dev:prepare — the developer-owned runtime root, outside the working tree.\nDEPLOYHUB_ROOT=${root}\n`;
    added.push("DEPLOYHUB_ROOT");
  } else {
    already.push("DEPLOYHUB_ROOT");
  }

  if (readEnvValue(contents, "DEPLOYHUB_PASSWORD") === undefined) {
    appended += `\n# Added by dev:prepare — local only. Never the production password.\nDEPLOYHUB_PASSWORD=${generatePassword()}\n`;
    added.push("DEPLOYHUB_PASSWORD");
  } else {
    already.push("DEPLOYHUB_PASSWORD");
  }

  if (appended !== "") {
    appendFileSync(path, appended);
    chmodSync(path, SECRETS_MODE);
  }

  return { path, created: false, added, already };
}

/**
 * Read one variable out of an env file's contents.
 *
 * Deliberately not a dotenv parser: this needs to answer "has the developer already set this" for
 * two known keys, and a variable set to the empty string has not been set for that purpose.
 */
export function readEnvValue(contents: string, key: string): string | undefined {
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1 || trimmed.slice(0, separator).trim() !== key) {
      continue;
    }
    const value = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
    return value === "" ? undefined : value;
  }
  return undefined;
}

/* -- Internals ------------------------------------------------------------ */

function assertUsableRoot(root: string, uid: number): void {
  if (!isAbsolute(root)) {
    throw new DevSetupError(
      `The runtime root must be an absolute path (got '${root}'). The dev server, the worker, and the CLI do not share a working directory, so a relative root would give them different databases.`,
    );
  }

  if (root.includes("..")) {
    throw new DevSetupError(`The runtime root must not contain '..' (got '${root}').`);
  }

  if (uid === 0) {
    throw new DevSetupError(
      "Refusing to prepare a local runtime root as root: a root-owned data root is exactly the failure the startup check exists to report. Run this as your own user, and use docs/ops/install.sh for a server.",
    );
  }

  for (const reserved of RESERVED_PREFIXES) {
    if (root === reserved || root.startsWith(`${reserved}${sep}`)) {
      throw new DevSetupError(
        `Refusing to prepare '${root}': that is a system directory. Use docs/ops/install.sh to prepare a server, or set DEPLOYHUB_ROOT to a path under your home directory.`,
      );
    }
  }

  if (root.split(sep).filter((segment) => segment !== "").length < 2) {
    throw new DevSetupError(
      `Refusing to prepare '${root}': expected a nested path such as ${defaultDevRoot()}.`,
    );
  }

  if (existsSync(root) && !statSync(root).isDirectory()) {
    throw new DevSetupError(`'${root}' exists and is not a directory.`);
  }
}

function ensureDirectory(path: string, changed: string[], already: string[]): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: DIR_MODE });
    // `mkdir`'s mode is masked by the umask, so set it explicitly rather than assume 022.
    chmodSync(path, DIR_MODE);
    changed.push(`created ${path}`);
    return;
  }

  if (!statSync(path).isDirectory()) {
    throw new DevSetupError(`'${path}' exists and is not a directory.`);
  }
  already.push(`${path} exists`);
}

function ensureSecretsFile(path: string, changed: string[], already: string[]): void {
  if (!existsSync(path)) {
    writeFileSync(path, "{}\n", { mode: SECRETS_MODE });
    chmodSync(path, SECRETS_MODE);
    changed.push(`created ${path} containing {}`);
    return;
  }

  const info = statSync(path);
  if (!info.isFile()) {
    throw new DevSetupError(`'${path}' exists and is not a regular file.`);
  }

  // The mode is corrected because `FileSecretProvider` refuses to read anything looser, but the
  // contents are never touched: they are the only copy of whatever is in there.
  if ((info.mode & 0o777) !== SECRETS_MODE) {
    chmodSync(path, SECRETS_MODE);
    changed.push(`chmod 600 ${path}`);
    return;
  }
  already.push(`${path} exists (left untouched — it holds real credentials)`);
}

function template(root: string, password: string): string {
  return `# DeployHub — local development environment.
#
# Written by \`npm run dev:prepare\`. Git-ignored, and excluded from the Docker build context,
# so nothing here can reach an image. Production configuration is
# /etc/deployhub/deployhub.env on the server and is not derived from this file.

NEXT_PUBLIC_APP_URL=http://localhost:3000

# The developer-owned runtime root: SQLite database, project workspaces, secrets.json.
# Outside the working tree, because it is state rather than source. The image sets
# /var/lib/deployhub instead, prepared by docs/ops/install.sh.
DEPLOYHUB_ROOT=${root}

# Local only, generated per machine. Not the production password, and not shared.
# Rotate by deleting this line and re-running \`npm run dev:prepare\`.
DEPLOYHUB_PASSWORD=${password}
DEPLOYHUB_ACTOR=dashboard

# Deployed containers publish on loopback. The public route a deployment verifies through is
# plain http on :3000 locally, where production serves https on :443.
DEPLOYHUB_BIND_HOST=127.0.0.1
DEPLOYHUB_PUBLIC_SCHEME=http
DEPLOYHUB_PUBLIC_PORT=3000
`;
}
