/**
 * `GitClient` over the command runner.
 *
 * One public method, matching the port: put the workspace at a ref and return the commit it
 * resolved to. Cloning on first use, discarding local changes, and resolving the ref are
 * steps in service of that answer.
 *
 * Every command here was verified against real git — see `docs/ops/host-spike.md`.
 *
 * Authentication is not this file's concern beyond opening and closing it. `auth-session.ts` turns
 * the project's configured method into extra arguments and extra environment, and the sequence below
 * is identical whether the repository is reached with a deploy key or a token. The credential never
 * appears in argv either way, because a failed command's argv is written to the deployment log and
 * its environment is not.
 */

import {
  type CommitSha,
  type GitRef,
  type Result,
  CommitSha as CommitShaCodec,
  DeploymentError,
  err,
  ok,
} from "@/core/shared";
import type { Project } from "@/core/domain";
import type { GitClient } from "@/core/ports";

import { type CommandRequest, type CommandRunner, commandFailure } from "../command-runner";
import type { SecretProvider } from "@/core/ports";
import { type WorkspaceLayout, workspaceFor } from "../workspace";
import { type AuthSession, openAuthSession } from "./auth-session";

const CLONE_TIMEOUT_MILLIS = 300_000;
const GIT_TIMEOUT_MILLIS = 120_000;

export type GitAdapterOptions = WorkspaceLayout;

export class CommandGitClient implements GitClient {
  constructor(
    private readonly runner: CommandRunner,
    private readonly secrets: SecretProvider,
    private readonly options: GitAdapterOptions,
  ) {}

  async checkOut(project: Project, ref: GitRef): Promise<Result<CommitSha>> {
    const session = await openAuthSession(project, this.secrets);
    if (!session.ok) {
      return session;
    }

    // The `finally` is why the session is opened here rather than inside each step: an SSH session
    // holds a private key on disk, and every path out of this method — success, a failed fetch, a
    // ref that does not exist — has to remove it.
    try {
      return await this.checkOutWith(project, ref, session.value);
    } finally {
      session.value.dispose();
    }
  }

  private async checkOutWith(
    project: Project,
    ref: GitRef,
    session: AuthSession,
  ): Promise<Result<CommitSha>> {
    const workspace = workspaceFor(this.options, project);

    const prepared = await this.ensureWorkspace(project, workspace, session);
    if (!prepared.ok) {
      return prepared;
    }

    const fetched = await this.git(
      workspace,
      session,
      ["fetch", "--prune", "--tags", "--quiet", "origin"],
      GIT_TIMEOUT_MILLIS,
    );
    if (!fetched.ok) {
      return err(this.classifyFetchFailure(fetched.error));
    }

    const sha = await this.resolve(workspace, session, ref);
    if (!sha.ok) {
      return sha;
    }

    // Detach rather than track a branch: the workspace exists to hold one commit, and a
    // tracking branch would invite a merge where a reset is wanted.
    const checkedOut = await this.git(
      workspace,
      session,
      ["checkout", "--detach", "--force", "--quiet", sha.value],
      GIT_TIMEOUT_MILLIS,
    );
    if (!checkedOut.ok) {
      return checkedOut;
    }

    // Remove ignored and untracked files too. A build must not see debris from the last one.
    const cleaned = await this.git(workspace, session, ["clean", "-qfdx"], GIT_TIMEOUT_MILLIS);
    return cleaned.ok ? ok(sha.value) : cleaned;
  }

  private async ensureWorkspace(
    project: Project,
    workspace: string,
    session: AuthSession,
  ): Promise<Result<void>> {
    const isRepository = await this.runner.run({
      command: "git",
      args: ["-C", workspace, "rev-parse", "--git-dir"],
      timeoutMillis: GIT_TIMEOUT_MILLIS,
    });
    if (isRepository.ok && isRepository.value.exitCode === 0) {
      // Already cloned. Keep the remote in step with the configuration in case it changed —
      // including a project moved from an https:// URL to its SSH form.
      const updated = await this.git(
        workspace,
        session,
        ["remote", "set-url", "origin", project.config.repositoryUrl],
        GIT_TIMEOUT_MILLIS,
      );
      return updated.ok ? ok(undefined) : updated;
    }

    const cloned = await this.git(
      undefined,
      session,
      ["clone", "--quiet", project.config.repositoryUrl, workspace],
      CLONE_TIMEOUT_MILLIS,
    );
    if (!cloned.ok) {
      return err(this.classifyFetchFailure(cloned.error));
    }
    return ok(undefined);
  }

  /**
   * A ref may be a branch, a tag, or a sha.
   *
   * The remote branch is tried first, so `main` means `origin/main` rather than whatever a
   * stale local branch points at. A bare sha resolves directly, which is the rollback case —
   * reachable because the fetch above brought everything down.
   */
  private async resolve(
    workspace: string,
    session: AuthSession,
    ref: GitRef,
  ): Promise<Result<CommitSha>> {
    for (const candidate of [`refs/remotes/origin/${ref}^{commit}`, `${ref}^{commit}`]) {
      const resolved = await this.runner.run({
        command: "git",
        args: ["-C", workspace, "rev-parse", "--verify", "--quiet", candidate],
        env: session.env,
        timeoutMillis: GIT_TIMEOUT_MILLIS,
      });
      if (!resolved.ok) {
        return resolved;
      }
      if (resolved.value.exitCode === 0) {
        return CommitShaCodec.parse(resolved.value.stdout.trim());
      }
    }

    return err(
      DeploymentError.of("GIT_REF_NOT_FOUND", `"${ref}" does not exist in the repository`, {
        details: { ref },
      }),
    );
  }

  private async git(
    cwd: string | undefined,
    session: AuthSession,
    args: readonly string[],
    timeoutMillis: number,
  ): Promise<Result<string>> {
    const request: CommandRequest = {
      command: "git",
      args: [...session.extraArgs, ...args],
      ...(cwd === undefined ? {} : { cwd }),
      env: session.env,
      timeoutMillis,
    };
    const result = await this.runner.run(request);
    if (!result.ok) {
      return result;
    }
    return result.value.exitCode === 0
      ? ok(result.value.stdout.trim())
      : err(commandFailure(request, result.value, "COMMAND_FAILED"));
  }

  /**
   * Separate an authentication problem from a network one.
   *
   * They demand different responses — one is a configuration fix, the other might resolve on
   * its own — and telling them apart from git's exit code alone is impossible, so the message
   * is the only signal available.
   *
   * The SSH phrases are not interchangeable with the HTTPS ones. `host key verification failed`
   * in particular has to land on the precondition side: it means the pinned host keys and the
   * server disagree, which no amount of retrying fixes, and classifying it as transient would
   * have the engine retry a deployment that can only fail the same way. `no such identity` and
   * `invalid format` are the two ways a bad key in the secret store surfaces.
   */
  private classifyFetchFailure(error: DeploymentError): DeploymentError {
    const message = error.message.toLowerCase();
    const looksLikeAuth =
      message.includes("authentication failed") ||
      message.includes("could not read username") ||
      message.includes("permission denied") ||
      message.includes("access denied") ||
      message.includes("host key verification failed") ||
      message.includes("no such identity") ||
      message.includes("invalid format") ||
      message.includes("error in libcrypto") ||
      message.includes("repository not found");
    return DeploymentError.of(
      looksLikeAuth ? "GIT_AUTH_FAILED" : "GIT_FETCH_FAILED",
      error.message,
      { details: error.details },
    );
  }
}
