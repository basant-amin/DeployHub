// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Result, DeploymentError, err, ok } from "@/core/shared";
import { Project } from "@/core/domain";
import type { SecretProvider } from "@/core/ports";
import { expectErr, expectOk } from "@/core/shared/result.testing";
import { validRawConfig } from "@/core/domain/deployments/deployment.fixtures";

import type { CommandRequest, CommandResult, CommandRunner } from "../command-runner";
import { CommandGitClient } from "./git-client";
import { authBaseDirectory } from "./ssh-key";

/**
 * The adapter had no tests before SSH support was added, which is how a credential mechanism can be
 * rewritten without anything noticing. These assert the two things that are genuinely dangerous to
 * get wrong — that a secret never reaches argv, and that a private key never outlives the checkout —
 * against a runner that records every command instead of running one.
 */

const SHA = "a".repeat(40);
const KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----`;
const TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwx";

let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "deployhub-git-"));
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  // Nothing here should have survived its own `finally`, but a leaked key must not leak into the
  // next test either.
  rmSync(authBaseDirectory(), { recursive: true, force: true });
});

/** Records every request, and answers each command the checkout sequence issues. */
class RecordingRunner implements CommandRunner {
  readonly requests: CommandRequest[] = [];

  constructor(private readonly failing: { readonly onArg?: string } = {}) {}

  async run(request: CommandRequest): Promise<Result<CommandResult>> {
    this.requests.push(request);
    const args = request.args.join(" ");

    if (this.failing.onArg !== undefined && args.includes(this.failing.onArg)) {
      return ok({ exitCode: 128, stdout: "", stderr: "Host key verification failed." });
    }
    // Not a repository yet, so the sequence clones.
    if (args.includes("rev-parse --git-dir")) {
      return ok({ exitCode: 128, stdout: "", stderr: "not a git repository" });
    }
    if (args.includes("rev-parse --verify")) {
      return ok({ exitCode: 0, stdout: `${SHA}\n`, stderr: "" });
    }
    return ok({ exitCode: 0, stdout: "", stderr: "" });
  }

  /** Every argument of every command, as one string. What must never contain a secret. */
  get allArgs(): string {
    return this.requests.map((request) => request.args.join(" ")).join("\n");
  }

  environmentValues(name: string): readonly string[] {
    return this.requests
      .map((request) => request.env?.[name])
      .filter((value): value is string => value !== undefined);
  }
}

function secretsReturning(...values: readonly string[]): SecretProvider {
  const queue = [...values];
  return {
    exists: async () => ok(true),
    resolveCredential: async () => {
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return next === undefined
        ? err(DeploymentError.of("PREFLIGHT_CREDENTIAL_MISSING", "no secret", { details: {} }))
        : ok(next);
    },
    resolveEnvironment: async () => ok(new Map()),
  };
}

function projectWith(gitAuth: unknown, repositoryUrl: string): Project {
  return expectOk(
    Project.create({
      id: "prj-0000000000000001",
      name: "One Community",
      slug: "one-community",
      config: { ...validRawConfig, repositoryUrl, gitAuth },
    }),
  );
}

const sshProject = (knownHostsRef?: string): Project =>
  projectWith(
    knownHostsRef === undefined
      ? { method: "ssh-deploy-key" }
      : { method: "ssh-deploy-key", knownHostsRef },
    "git@github.com:elemta/one-community.git",
  );

const httpsProject = (): Project =>
  projectWith({ method: "https-token" }, "https://github.com/elemta/one-community");

function clientFor(runner: CommandRunner, secrets: SecretProvider): CommandGitClient {
  return new CommandGitClient(runner, secrets, { root: workspaceRoot });
}

/** The one session directory the checkout created, read out of the ssh command git was given. */
function keyPathFrom(sshCommand: string): string {
  const match = /-i '([^']+)'/.exec(sshCommand);
  if (match?.[1] === undefined) {
    throw new Error(`no key path in: ${sshCommand}`);
  }
  return match[1];
}

describe("the HTTPS token path", () => {
  it("still authenticates with a credential helper, and never mentions ssh", async () => {
    const runner = new RecordingRunner();
    const checkedOut = await clientFor(runner, secretsReturning(TOKEN)).checkOut(
      httpsProject(),
      "main" as never,
    );

    expect(expectOk(checkedOut)).toBe(SHA);
    expect(runner.allArgs).toContain("credential.helper=");
    expect(runner.environmentValues("DEPLOYHUB_GIT_TOKEN")).toContain(TOKEN);
    expect(runner.environmentValues("GIT_SSH_COMMAND")).toEqual([]);
  });

  it("keeps the token out of argv", async () => {
    const runner = new RecordingRunner();
    await clientFor(runner, secretsReturning(TOKEN)).checkOut(httpsProject(), "main" as never);

    // The helper is an argument; the token it reads is not. Argv is written to the deployment log.
    expect(runner.allArgs).not.toContain(TOKEN);
  });
});

describe("the SSH deploy-key path", () => {
  it("hands git an ssh command with verification on, and no credential helper", async () => {
    const runner = new RecordingRunner();
    const checkedOut = await clientFor(runner, secretsReturning(KEY)).checkOut(
      sshProject(),
      "main" as never,
    );

    expect(expectOk(checkedOut)).toBe(SHA);

    const [sshCommand] = runner.environmentValues("GIT_SSH_COMMAND");
    expect(sshCommand).toBeDefined();
    expect(sshCommand).toContain("-o StrictHostKeyChecking=yes");
    expect(sshCommand).toContain("-o IdentitiesOnly=yes");
    expect(sshCommand).toContain("-o IdentityAgent=none");
    expect(sshCommand).toContain("-o UserKnownHostsFile=");

    // Never weakened, whatever else changes.
    expect(sshCommand).not.toContain("StrictHostKeyChecking=no");
    expect(sshCommand).not.toContain("accept-new");

    // git does not consult a credential helper over SSH; offering one only confuses the failure.
    expect(runner.allArgs).not.toContain("credential.helper=");
  });

  it("keeps the private key out of argv and out of the command line", async () => {
    const runner = new RecordingRunner();
    await clientFor(runner, secretsReturning(KEY)).checkOut(sshProject(), "main" as never);

    expect(runner.allArgs).not.toContain("PRIVATE KEY");
    expect(runner.environmentValues("GIT_SSH_COMMAND").join(" ")).not.toContain("PRIVATE KEY");
  });

  it("writes the key 0600 in a 0700 directory, outside the workspace", async () => {
    const runner = new RecordingRunner();
    let observed: { keyPath: string; dirMode: number; keyMode: number } | undefined;

    // Modes are captured mid-checkout, because the directory is gone by the time it returns.
    const capturing: CommandRunner = {
      run: async (request) => {
        const [sshCommand] = [request.env?.GIT_SSH_COMMAND].filter(
          (value): value is string => value !== undefined,
        );
        if (sshCommand !== undefined && observed === undefined) {
          const keyPath = keyPathFrom(sshCommand);
          observed = {
            keyPath,
            dirMode: statSync(join(keyPath, "..")).mode & 0o777,
            keyMode: statSync(keyPath).mode & 0o777,
          };
        }
        return runner.run(request);
      },
    };

    await clientFor(capturing, secretsReturning(KEY)).checkOut(sshProject(), "main" as never);

    expect(observed).toBeDefined();
    expect(observed?.keyMode).toBe(0o600);
    expect(observed?.dirMode).toBe(0o700);
    // The workspace is what `docker build` streams as its context; a key there could reach a layer.
    expect(observed?.keyPath.startsWith(workspaceRoot)).toBe(false);
  });

  it("removes the key after a successful checkout", async () => {
    const runner = new RecordingRunner();
    await clientFor(runner, secretsReturning(KEY)).checkOut(sshProject(), "main" as never);

    const keyPath = keyPathFrom(runner.environmentValues("GIT_SSH_COMMAND")[0] ?? "");
    expect(existsSync(keyPath)).toBe(false);
    expect(readdirSync(authBaseDirectory())).toEqual([]);
  });

  it("removes the key after a failed fetch, which is the path that matters", async () => {
    // A `finally` that only runs on success is not a `finally`. This is the case that leaves a
    // private key behind in the container's writable layer.
    const runner = new RecordingRunner({ onArg: "fetch" });
    const failed = await clientFor(runner, secretsReturning(KEY)).checkOut(
      sshProject(),
      "main" as never,
    );

    expect(failed.ok).toBe(false);
    const keyPath = keyPathFrom(runner.environmentValues("GIT_SSH_COMMAND")[0] ?? "");
    expect(existsSync(keyPath)).toBe(false);
    expect(readdirSync(authBaseDirectory())).toEqual([]);
  });

  it("reads a host-key failure as a configuration problem, not a transient one", async () => {
    // The distinction decides whether the engine retries. Pinned keys that disagree with the server
    // will disagree again on every attempt, so retrying only wastes a deployment.
    const runner = new RecordingRunner({ onArg: "fetch" });
    const error = expectErr(
      await clientFor(runner, secretsReturning(KEY)).checkOut(sshProject(), "main" as never),
    );

    expect(error.code).toBe("GIT_AUTH_FAILED");
  });

  it("refuses a credential that is not a private key, before running git at all", async () => {
    const runner = new RecordingRunner();
    const error = expectErr(
      await clientFor(runner, secretsReturning(TOKEN)).checkOut(sshProject(), "main" as never),
    );

    expect(error.code).toBe("PREFLIGHT_CREDENTIAL_MISSING");
    expect(error.message).toContain("git:keygen");
    expect(runner.requests).toEqual([]);
  });

  it("verifies against the bundled GitHub host keys when no override is configured", async () => {
    const runner = new RecordingRunner();
    let knownHosts: string | undefined;

    const capturing: CommandRunner = {
      run: async (request) => {
        const sshCommand = request.env?.GIT_SSH_COMMAND;
        if (sshCommand !== undefined && knownHosts === undefined) {
          const match = /-o UserKnownHostsFile='([^']+)'/.exec(sshCommand);
          if (match?.[1] !== undefined) {
            knownHosts = readFileSync(match[1], "utf8");
          }
        }
        return runner.run(request);
      },
    };

    await clientFor(capturing, secretsReturning(KEY)).checkOut(sshProject(), "main" as never);

    expect(knownHosts).toContain("github.com ssh-ed25519 ");
  });

  it("uses the override instead when one is configured", async () => {
    const enterprise = "git.acme.internal ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOverrideKeyHere";
    const runner = new RecordingRunner();
    let knownHosts: string | undefined;

    const capturing: CommandRunner = {
      run: async (request) => {
        const sshCommand = request.env?.GIT_SSH_COMMAND;
        if (sshCommand !== undefined && knownHosts === undefined) {
          const match = /-o UserKnownHostsFile='([^']+)'/.exec(sshCommand);
          if (match?.[1] !== undefined) {
            knownHosts = readFileSync(match[1], "utf8");
          }
        }
        return runner.run(request);
      },
    };

    // The key is resolved first, then the override, in that order.
    await clientFor(capturing, secretsReturning(KEY, enterprise)).checkOut(
      sshProject("acme.known-hosts"),
      "main" as never,
    );

    expect(knownHosts).toContain("git.acme.internal");
    expect(knownHosts).not.toContain("github.com");
  });
});
