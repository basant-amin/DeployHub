/**
 * The startup check — refuse to boot into a state that will fail later.
 *
 * `src/config/env.ts` establishes the rule for configuration: validate once, at load, and throw
 * with an actionable message rather than start and fail somewhere confusing. This is the same
 * rule applied to the things configuration *points at* — a directory, a file, a socket — which
 * environment validation cannot check because their problems are on the host, not in a string.
 *
 * It exists because of a real incident on the first production install. The data root had been
 * created by Docker rather than by hand, so it was `root:root` and the container's uid could not
 * write it. The worker crash-looped on `ERR_SQLITE_ERROR: unable to open database file` — four
 * layers away from the one-line cause — and the web container was worse: `getPlatform()` is lazy,
 * so Next booted, `/signin` served 200, the container reported healthy, and the failure waited
 * until someone opened the dashboard. A container that is broken must say so at startup.
 *
 * Every problem carries the command that fixes it. Reporting "permission denied" to someone who
 * then has to work out which path, which uid, and which mode is most of the cost of the failure.
 *
 * All problems are collected before reporting. Fixing one thing, restarting, and discovering the
 * next is how a five-minute install becomes an afternoon.
 */

import { constants, existsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { accessSync } from "node:fs";

import type { RuntimeConfig } from "./composition";

/** Where the daemon listens, unless `DOCKER_HOST` redirects the client elsewhere. */
export const DEFAULT_DOCKER_SOCKET = "/var/run/docker.sock";

/** How long to wait for the daemon to accept a connection before calling it unreachable. */
const SOCKET_TIMEOUT_MILLIS = 2_000;

/**
 * Who prepares this host, and therefore which command to suggest.
 *
 * The *check* is identical either way — that is not negotiable, since a guard that is relaxed on
 * the machine where the code is written has never been exercised. Only the repair instructions
 * differ, and they have to: `sudo docs/ops/install.sh` on a developer's Mac creates a data root
 * owned by uid 1000, which the very next boot rejects as unreadable. Advice that produces a
 * different problem is worse than no advice.
 */
export type HostKind = "system" | "developer";

const INSTALLER_HINT = "The installer does all of this: sudo docs/ops/install.sh";
const DEVELOPER_HINT = "Local development prepares all of this: npm run dev:prepare";

/**
 * A root under the home directory is a developer's; anything else belongs to the installer.
 *
 * Chosen over matching `/var`-like prefixes because the interesting paths are not reliably
 * distinguishable that way — macOS puts temporary directories under `/var/folders` — while
 * "inside the home directory" is exactly the property that makes a root developer-owned.
 */
export function hostKindOf(dataRoot: string, home: string = homedir()): HostKind {
  return dataRoot === home || dataRoot.startsWith(`${home}${sep}`) ? "developer" : "system";
}

/** The closing line of a problem report: the one command that fixes the whole list. */
export function hintFor(config: RuntimeConfig, options: StartupCheckOptions = {}): string {
  return hostKindOf(dirname(config.databasePath), options.home) === "developer"
    ? DEVELOPER_HINT
    : INSTALLER_HINT;
}

export interface RuntimeProblem {
  /** What is wrong, in terms of the host rather than the driver's errno. */
  readonly what: string;
  /** A command that fixes it, ready to paste. */
  readonly fix: string;
}

export interface StartupCheckOptions {
  /**
   * Unix socket the Docker client will use. Skipped entirely when `DOCKER_HOST` is set, because
   * the client is then talking to something else and this path is not the thing to check.
   */
  readonly dockerSocket?: string | undefined;
  /** The uid the process runs as. Injected so the ownership rule is testable. */
  readonly uid?: number | undefined;
  /**
   * The home directory that decides whether this is a developer's host or a server's. Injected so
   * the rule is testable without depending on where the test runner's temp directory lands.
   */
  readonly home?: string | undefined;
}

export class StartupCheckError extends Error {
  constructor(readonly problems: readonly RuntimeProblem[]) {
    super(formatProblems(problems));
    this.name = "StartupCheckError";
  }
}

/**
 * Render the problems as something an operator can act on without reading source.
 *
 * Exported because the two entrypoints print it differently — the worker to stderr before
 * exiting, Next through its own error handling — and both need the same text.
 */
export function formatProblems(
  problems: readonly RuntimeProblem[],
  hint: string = INSTALLER_HINT,
): string {
  const lines = problems.map((problem, index) => {
    return `  ${index + 1}. ${problem.what}\n     fix: ${problem.fix}`;
  });
  return ["DeployHub cannot start. The host is not prepared:", "", ...lines, "", hint].join("\n");
}

/**
 * Check everything the platform needs from the host, and return every problem found.
 *
 * Returns rather than throws, so a caller can decide how to report. An empty array means the
 * platform will be able to open its database, read its secrets, and reach Docker.
 */
export function checkRuntime(
  config: RuntimeConfig,
  options: StartupCheckOptions = {},
): readonly RuntimeProblem[] {
  const problems: RuntimeProblem[] = [];
  const uid = options.uid ?? process.getuid?.() ?? 0;
  const dataRoot = dirname(config.databasePath);
  const kind = hostKindOf(dataRoot, options.home);

  problems.push(...checkWritableDirectory(dataRoot, "The data root", kind));

  // Checked separately because it is usually inside the data root but does not have to be, and
  // because git creates checkouts here — a readable-but-not-writable workspace fails at the
  // fetch step of the first deployment rather than at boot.
  if (config.workspaceRoot !== dataRoot) {
    problems.push(...checkWritableDirectory(config.workspaceRoot, "The workspace root", kind));
  }

  problems.push(...checkSecretsFile(config.secretsPath, uid, kind));
  problems.push(...checkDockerSocket(options.dockerSocket, kind));

  return problems;
}

/** Throw if anything is wrong. The form both entrypoints use. */
export function assertRuntimeReady(config: RuntimeConfig, options: StartupCheckOptions = {}): void {
  const problems = checkRuntime(config, options);
  if (problems.length > 0) {
    throw new StartupCheckError(problems);
  }
}

function checkWritableDirectory(
  path: string,
  label: string,
  kind: HostKind,
): readonly RuntimeProblem[] {
  let info;
  try {
    info = statSync(path);
  } catch {
    return [
      {
        what:
          kind === "developer"
            ? `${label} ${path} does not exist. Local development keeps its runtime state outside the working tree, so it is created once rather than by cloning.`
            : `${label} ${path} does not exist. Docker creates a missing bind-mount source as root, so this usually means the container was started before the host was prepared.`,
        fix:
          kind === "developer"
            ? "npm run dev:prepare"
            : `sudo docs/ops/install.sh --root ${rootOf(path)}`,
      },
    ];
  }

  if (!info.isDirectory()) {
    return [
      {
        what: `${label} ${path} exists but is not a directory.`,
        fix: `ls -l ${path}   # then move or remove whatever is there`,
      },
    ];
  }

  // A write probe rather than `access(W_OK)`: access answers about permission bits, and the
  // cases that actually bite — a read-only mount, a full filesystem — are invisible to it.
  const probe = join(path, `.deployhub-write-probe-${process.pid}`);
  try {
    writeFileSync(probe, "");
    unlinkSync(probe);
  } catch (cause) {
    const owner = describeOwner(info);
    const self = process.getuid?.() ?? 0;
    return [
      {
        what: `${label} ${path} is not writable by uid ${process.getuid?.() ?? "?"} (${owner}): ${messageOf(cause)}`,
        fix:
          kind === "developer"
            ? `chown ${self}:$(id -g) ${path} && chmod 700 ${path}`
            : `sudo chown 1000:1000 ${path} && sudo chmod 750 ${path}`,
      },
    ];
  }

  return [];
}

function checkSecretsFile(path: string, uid: number, kind: HostKind): readonly RuntimeProblem[] {
  let info;
  try {
    info = statSync(path);
  } catch {
    return [
      {
        what: `The secrets file ${path} does not exist. It is read on every deployment and there is no write path, so the platform cannot create it.`,
        fix:
          kind === "developer"
            ? "npm run dev:prepare"
            : `sudo install -o 1000 -g 1000 -m 600 /dev/null ${path} && echo '{}' | sudo tee ${path} > /dev/null`,
      },
    ];
  }

  const problems: RuntimeProblem[] = [];

  if (!info.isFile()) {
    return [
      {
        what: `The secrets file ${path} is not a regular file.`,
        fix: `ls -l ${path}   # then move or remove whatever is there`,
      },
    ];
  }

  // The same rule `FileSecretProvider` enforces, checked here so it fails at boot rather than
  // at the first deployment. A secret file any group or other can read is not a secret file.
  // No `sudo` in the developer form: these paths are inside the home directory, and a suggestion
  // to sudo-chown something you already own teaches the wrong reflex.
  const sudo = kind === "developer" ? "" : "sudo ";

  const mode = info.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    problems.push({
      what: `The secrets file ${path} is mode ${mode.toString(8)}; it must be 600 so only its owner can read it.`,
      fix: `${sudo}chmod 600 ${path}`,
    });
  }

  if (info.uid !== uid) {
    problems.push({
      what: `The secrets file ${path} is owned by uid ${info.uid}, but this process runs as uid ${uid}. At mode 600 that makes it unreadable.`,
      fix: `${sudo}chown ${uid}:${uid} ${path}`,
    });
  }

  try {
    accessSync(path, constants.R_OK);
  } catch (cause) {
    problems.push({
      what: `The secrets file ${path} cannot be read: ${messageOf(cause)}`,
      fix: `${sudo}chown ${uid}:${uid} ${path} && ${sudo}chmod 600 ${path}`,
    });
  }

  return problems;
}

/**
 * Whether the Docker socket is there and will accept a connection.
 *
 * Connecting rather than running `docker version`: it is faster, needs no subprocess, and
 * distinguishes the two failures that matter. Absent means the socket was not mounted; `EACCES`
 * means it was, but this uid is not in the host's `docker` group — which is the single most
 * likely thing to be wrong on a first install, and the least obvious from any later error.
 */
function checkDockerSocket(
  socketPath: string | undefined,
  kind: HostKind,
): readonly RuntimeProblem[] {
  if (socketPath === undefined) {
    return [];
  }

  if (!existsSync(socketPath)) {
    return [
      {
        what:
          kind === "developer"
            ? `The Docker socket ${socketPath} is not present. Every deployment needs it, and locally that means Docker itself is not running.`
            : `The Docker socket ${socketPath} is not present in this container. Every deployment needs it.`,
        fix:
          kind === "developer"
            ? "start Docker, then check it answers: docker version"
            : `add --mount type=bind,source=${socketPath},target=${socketPath} to docker run`,
      },
    ];
  }

  try {
    accessSync(socketPath, constants.R_OK | constants.W_OK);
  } catch {
    return [
      {
        what:
          kind === "developer"
            ? `The Docker socket ${socketPath} is present but not accessible to uid ${process.getuid?.() ?? "?"}.`
            : `The Docker socket ${socketPath} is present but not accessible to uid ${process.getuid?.() ?? "?"}. The container is not a member of the host's docker group.`,
        fix:
          kind === "developer"
            ? "check that your user can use Docker: docker version"
            : `add --group-add "$(getent group docker | cut -d: -f3)" to docker run`,
      },
    ];
  }

  return [];
}

/**
 * The path the installer should be pointed at.
 *
 * A missing `<root>/projects` is fixed by preparing `<root>`, not by preparing `<root>/projects`,
 * so the suggested command names the parent when the missing path is the workspace directory.
 */
function rootOf(path: string): string {
  return path.endsWith("/projects") ? dirname(path) : path;
}

function describeOwner(info: {
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
}): string {
  return `owned by ${info.uid}:${info.gid}, mode ${(info.mode & 0o777).toString(8)}`;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The socket to check, or `undefined` when the client has been pointed elsewhere.
 *
 * `DOCKER_HOST` overrides the socket for the CLI, so checking the default path would report a
 * problem that is not one.
 */
export function dockerSocketFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.DOCKER_HOST === undefined || env.DOCKER_HOST === ""
    ? DEFAULT_DOCKER_SOCKET
    : undefined;
}

/**
 * Kept for the case where a caller wants proof the daemon answers, not merely that the socket is
 * openable. Not part of the boot check: the per-deployment preflight already calls
 * `docker version` through the adapter, and paying for a connection handshake at every boot to
 * learn what the first deployment learns anyway is not a good trade.
 */
export async function daemonAccepts(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    const settle = (answer: boolean): void => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(SOCKET_TIMEOUT_MILLIS);
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.once("timeout", () => settle(false));
  });
}
