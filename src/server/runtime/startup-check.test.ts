// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runtimeConfigFromEnv, type RuntimeConfig } from "./composition";
import { checkRuntime, assertRuntimeReady, formatProblems } from "./startup-check";

let root: string;

/** Permission bits do not constrain root, so the two tests that rely on them cannot run as root. */
const asUnprivilegedUser = it.skipIf(process.getuid?.() === 0);

/** A config rooted at `path`. Spreads the real env so `NodeJS.ProcessEnv` is satisfied. */
function configFor(path: string): RuntimeConfig {
  return runtimeConfigFromEnv({ ...process.env, DEPLOYHUB_ROOT: path });
}

/** A prepared host: data root, workspace, and a 0600 secrets file owned by this process. */
function prepare(): RuntimeConfig {
  mkdirSync(join(root, "projects"), { recursive: true });
  writeFileSync(join(root, "secrets.json"), "{}", { mode: 0o600 });
  chmodSync(join(root, "secrets.json"), 0o600);
  return configFor(root);
}

/** Everything except Docker, which is checked separately so tests do not need a daemon. */
function problemsIgnoringDocker(config: RuntimeConfig) {
  return checkRuntime(config, { dockerSocket: undefined });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deployhub-check-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a prepared host", () => {
  it("reports no problems", () => {
    expect(problemsIgnoringDocker(prepare())).toEqual([]);
  });

  it("does not leave its write probe behind", () => {
    const config = prepare();
    problemsIgnoringDocker(config);
    problemsIgnoringDocker(config);
    // Two runs, and the directory still holds only what the installer put there.
    expect(problemsIgnoringDocker(config)).toEqual([]);
  });
});

describe("the data root", () => {
  it("reports it missing, and blames the bind mount rather than the database", () => {
    // The real incident: Docker created the source path as root because it did not exist.
    const config = configFor(join(root, "absent"));
    const [problem] = problemsIgnoringDocker(config);

    expect(problem?.what).toContain("does not exist");
    expect(problem?.what).toContain("Docker creates a missing bind-mount source as root");
    expect(problem?.fix).toContain("install.sh");
  });

  it("reports a file where the directory should be", () => {
    const path = join(root, "notadir");
    writeFileSync(path, "");
    const config = configFor(path);

    expect(problemsIgnoringDocker(config)[0]?.what).toContain("is not a directory");
  });

  asUnprivilegedUser("reports it unwritable, and names the chown that fixes it", () => {
    const config = prepare();
    chmodSync(root, 0o555);
    try {
      const problem = problemsIgnoringDocker(config).find((p) => p.what.includes("data root"));
      expect(problem?.what).toContain("not writable");
      expect(problem?.fix).toContain("chown 1000:1000");
    } finally {
      chmodSync(root, 0o755);
    }
  });
});

describe("the secrets file", () => {
  it("reports it missing, and says the platform cannot create it", () => {
    mkdirSync(join(root, "projects"), { recursive: true });
    const config = configFor(root);

    const problem = problemsIgnoringDocker(config).find((p) => p.what.includes("secrets file"));
    expect(problem?.what).toContain("no write path");
    expect(problem?.fix).toContain("install -o 1000 -g 1000 -m 600");
  });

  it("refuses a mode any group or other can read, matching FileSecretProvider", () => {
    const config = prepare();
    chmodSync(join(root, "secrets.json"), 0o644);

    const problem = problemsIgnoringDocker(config).find((p) => p.what.includes("mode"));
    expect(problem?.what).toContain("644");
    expect(problem?.fix).toContain("chmod 600");
  });

  it("refuses an owner that is not this process, because 600 then makes it unreadable", () => {
    // Ownership is checked against an injected uid so the rule is testable without root.
    const config = prepare();
    const problem = checkRuntime(config, { dockerSocket: undefined, uid: 4242 }).find((p) =>
      p.what.includes("owned by uid"),
    );

    expect(problem?.what).toContain("uid 4242");
    expect(problem?.fix).toContain("chown 4242:4242");
  });
});

describe("the Docker socket", () => {
  it("reports it absent, and names the mount that supplies it", () => {
    const problem = checkRuntime(prepare(), {
      dockerSocket: join(root, "no-such.sock"),
    })[0];

    expect(problem?.what).toContain("not present in this container");
    expect(problem?.fix).toContain("--mount type=bind");
  });

  it("accepts a socket it can reach", async () => {
    const socketPath = join(root, "docker.sock");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      expect(checkRuntime(prepare(), { dockerSocket: socketPath })).toEqual([]);
    } finally {
      server.close();
    }
  });

  asUnprivilegedUser(
    "blames group membership when the socket is there but closed to this uid",
    async () => {
      const socketPath = join(root, "docker.sock");
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      chmodSync(socketPath, 0o000);
      try {
        const problem = checkRuntime(prepare(), { dockerSocket: socketPath })[0];
        // The single most likely first-install mistake, and the least obvious from any later error.
        expect(problem?.what).toContain("docker group");
        expect(problem?.fix).toContain("--group-add");
      } finally {
        server.close();
      }
    },
  );
});

describe("reporting", () => {
  it("collects every problem rather than stopping at the first", () => {
    // Fixing one thing, restarting, and finding the next is how a five-minute install
    // becomes an afternoon.
    const config = configFor(join(root, "absent"));
    const problems = checkRuntime(config, { dockerSocket: join(root, "no-such.sock") });

    expect(problems.length).toBeGreaterThanOrEqual(3);
    expect(problems.every((problem) => problem.fix.length > 0)).toBe(true);
  });

  it("renders every problem with its fix, and points at the installer", () => {
    const text = formatProblems([{ what: "something is wrong", fix: "do this" }]);

    expect(text).toContain("1. something is wrong");
    expect(text).toContain("fix: do this");
    expect(text).toContain("sudo docs/ops/install.sh");
  });

  it("throws on a bad host and stays quiet on a good one", () => {
    const bad = configFor(join(root, "absent"));
    expect(() => assertRuntimeReady(bad, { dockerSocket: undefined })).toThrow(/cannot start/i);
    expect(() => assertRuntimeReady(prepare(), { dockerSocket: undefined })).not.toThrow();
  });
});
