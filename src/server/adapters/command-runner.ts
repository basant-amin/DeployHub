/**
 * `CommandRunner` — run a process on this host.
 *
 * Not a port. The application layer never calls it; the git, docker, and proxy adapters
 * share it so that connection handling, timeouts, and output capture are solved once rather
 * than three times slightly differently. It lives here for that reason and no other
 * (`docs/architecture/modules.md`, "Not a port").
 *
 * Deliberately narrow: it knows how to execute a process and capture its streams, and
 * nothing about what it is running. There is no `docker` or `git` string in this file, which
 * is the whole point of the abstraction — the day a second host appears, an SSH
 * implementation of this interface is the only new code.
 *
 * Arguments are passed as an array and never interpolated into a shell, so a repository
 * name containing a semicolon is data rather than a second command.
 */

import { spawn } from "node:child_process";

import { type Result, DeploymentError, err, ok } from "@/core/shared";

export interface CommandRequest {
  readonly command: string;
  readonly args: readonly string[];
  /** Working directory. Defaults to the process's own. */
  readonly cwd?: string;
  /**
   * Extra environment for the child. Secrets belong here rather than in `args`, because a
   * failed command's argv is written to the deployment log and its environment is not.
   */
  readonly env?: Readonly<Record<string, string>>;
  /** Killed after this many milliseconds. Every command must have a bound. */
  readonly timeoutMillis: number;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * A non-zero exit is a **successful** run that returned a failure — the caller decides
 * whether that is an error, because only the caller knows that `git rev-parse` exiting 1
 * means "no such ref" rather than "something broke".
 *
 * The `Result` fails only when the process could not be run or did not finish in time.
 */
export interface CommandRunner {
  run(request: CommandRequest): Promise<Result<CommandResult>>;
}

const MAX_CAPTURED_BYTES = 4 * 1024 * 1024;

export class LocalCommandRunner implements CommandRunner {
  async run(request: CommandRequest): Promise<Result<CommandResult>> {
    return new Promise<Result<CommandResult>>((resolve) => {
      let settled = false;
      const finish = (result: Result<CommandResult>): void => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      const child = spawn(request.command, [...request.args], {
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        env: { ...process.env, ...request.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      const capture = (into: "out" | "err") => (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (into === "out") {
          stdout = truncate(stdout + text);
        } else {
          stderr = truncate(stderr + text);
        }
      };
      child.stdout.on("data", capture("out"));
      child.stderr.on("data", capture("err"));

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(
          err(
            DeploymentError.of(
              "STEP_TIMEOUT",
              `${describe(request)} did not finish within ${request.timeoutMillis}ms`,
              { details: { command: describe(request) } },
            ),
          ),
        );
      }, request.timeoutMillis);
      timer.unref();

      child.on("error", (cause) => {
        clearTimeout(timer);
        finish(
          err(
            DeploymentError.of(
              "COMMAND_FAILED",
              `${request.command} could not be started: ${cause.message}`,
              { details: { command: describe(request) } },
            ),
          ),
        );
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        finish(ok({ exitCode: code ?? -1, stdout, stderr }));
      });
    });
  }
}

/** The command as it would be typed, for log lines and error messages. Never the env. */
export function describe(request: CommandRequest): string {
  return [request.command, ...request.args].join(" ");
}

/**
 * Fail with the command's own stderr, for the common case where a non-zero exit *is* an
 * error. Keeps the last lines rather than the first: a build failure's cause is at the end.
 */
export function commandFailure(
  request: CommandRequest,
  result: CommandResult,
  code: Parameters<typeof DeploymentError.of>[0],
): DeploymentError {
  const output = (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-20).join("\n");
  return DeploymentError.of(
    code,
    `${describe(request)} exited ${result.exitCode}${output === "" ? "" : `: ${output}`}`,
    { details: { command: describe(request), exitCode: result.exitCode } },
  );
}

function truncate(text: string): string {
  return text.length > MAX_CAPTURED_BYTES ? text.slice(-MAX_CAPTURED_BYTES) : text;
}
