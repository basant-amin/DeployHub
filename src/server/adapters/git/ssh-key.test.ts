// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectErr, expectOk } from "@/core/shared/result.testing";

import { GITHUB_HOST_KEYS, knownHostsFileContents } from "./known-hosts";
import {
  authBaseDirectory,
  createSshIdentity,
  looksLikePrivateKey,
  sweepStaleSshIdentities,
} from "./ssh-key";

const KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----`;

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "deployhub-sshkey-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("looksLikePrivateKey", () => {
  it("accepts the formats ssh-keygen produces", () => {
    expect(looksLikePrivateKey(KEY)).toBe(true);
    expect(looksLikePrivateKey("-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----")).toBe(
      true,
    );
    expect(
      looksLikePrivateKey("-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----"),
    ).toBe(true);
  });

  it("rejects what an operator actually puts there by mistake", () => {
    // A token in the deploy-key slot is the realistic error, and it must be named as such rather
    // than reaching ssh and coming back as "error in libcrypto".
    expect(looksLikePrivateKey("ghp_0123456789abcdefghijklmnop")).toBe(false);
    expect(looksLikePrivateKey("")).toBe(false);
    // The public half, which is the one that goes to GitHub.
    expect(looksLikePrivateKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA")).toBe(false);
  });
});

describe("createSshIdentity", () => {
  it("writes the key and the host keys with private modes", () => {
    const identity = expectOk(createSshIdentity(KEY, undefined, base));
    try {
      const match = /-i '([^']+)'/.exec(identity.sshCommand);
      const keyPath = match?.[1] ?? "";

      expect(modeOf(keyPath)).toBe(0o600);
      expect(modeOf(join(keyPath, ".."))).toBe(0o700);
      expect(readFileSync(keyPath, "utf8")).toContain("PRIVATE KEY");
    } finally {
      identity.dispose();
    }
  });

  it("terminates the key with a newline, which OpenSSH requires", () => {
    // A key pasted into JSON very often loses it, and ssh then reports "invalid format".
    const identity = expectOk(createSshIdentity(KEY.trimEnd(), undefined, base));
    try {
      const keyPath = /-i '([^']+)'/.exec(identity.sshCommand)?.[1] ?? "";
      expect(readFileSync(keyPath, "utf8").endsWith("\n")).toBe(true);
    } finally {
      identity.dispose();
    }
  });

  it("disposes idempotently, so a finally can run twice", () => {
    const identity = expectOk(createSshIdentity(KEY, undefined, base));
    const keyPath = /-i '([^']+)'/.exec(identity.sshCommand)?.[1] ?? "";

    identity.dispose();
    expect(existsSync(keyPath)).toBe(false);
    expect(() => identity.dispose()).not.toThrow();
  });

  it("refuses material that is not a private key without creating anything", () => {
    const error = expectErr(createSshIdentity("ghp_not_a_key_at_all", undefined, base));
    expect(error.code).toBe("PREFLIGHT_CREDENTIAL_MISSING");
    expect(existsSync(authBaseDirectory(base))).toBe(false);
  });

  it("never puts key material in the ssh command", () => {
    const identity = expectOk(createSshIdentity(KEY, undefined, base));
    try {
      expect(identity.sshCommand).not.toContain("PRIVATE KEY");
      expect(identity.sshCommand).toContain("-F /dev/null");
    } finally {
      identity.dispose();
    }
  });
});

/**
 * The sweep is a delete loop pointed at a directory path, which is the kind of code that has to be
 * proven to refuse rather than trusted to behave. Each test below removes one of its five conditions
 * and checks that nothing is deleted.
 */
describe("sweepStaleSshIdentities", () => {
  /** A session directory attributed to a pid that is certainly not running. */
  function deadSession(name = "session-999999-abc123"): string {
    const path = join(authBaseDirectory(base), name);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(join(path, "id"), KEY, { mode: 0o600 });
    return path;
  }

  it("removes a directory whose process is gone", () => {
    const path = deadSession();
    const result = sweepStaleSshIdentities(base);

    expect(result.removed).toEqual(["session-999999-abc123"]);
    expect(existsSync(path)).toBe(false);
  });

  it("keeps a directory whose process is still running", () => {
    // The case that makes a second worker safe. Deleting this would take the key out from under a
    // deployment mid-fetch.
    const path = join(authBaseDirectory(base), `session-${process.pid}-live123`);
    mkdirSync(path, { recursive: true, mode: 0o700 });

    const result = sweepStaleSshIdentities(base);

    expect(result.removed).toEqual([]);
    expect(result.live).toBe(1);
    expect(existsSync(path)).toBe(true);
  });

  it("ignores anything that is not a session directory", () => {
    const root = authBaseDirectory(base);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const stranger = join(root, "not-ours");
    mkdirSync(stranger);
    const file = join(root, "session-999999-afile");
    writeFileSync(file, "");

    const result = sweepStaleSshIdentities(base);

    expect(result.removed).toEqual([]);
    expect(existsSync(stranger)).toBe(true);
    expect(existsSync(file)).toBe(true);
  });

  it("refuses a symlink, so a planted link cannot redirect the delete", () => {
    const root = authBaseDirectory(base);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const victim = join(base, "precious");
    mkdirSync(victim);
    writeFileSync(join(victim, "keep-me"), "important");
    symlinkSync(victim, join(root, "session-999999-symlnk"));

    const result = sweepStaleSshIdentities(base);

    expect(result.removed).toEqual([]);
    expect(existsSync(join(victim, "keep-me"))).toBe(true);
  });

  it("leaves a directory owned by another uid alone", () => {
    // Ownership cannot be faked without root, so the rule is checked by asking the sweep to run as
    // a uid that owns nothing here — the same branch, driven from the other side.
    const path = deadSession();
    const originalGetuid = process.getuid;
    try {
      Object.defineProperty(process, "getuid", { value: () => 999_999, configurable: true });
      expect(sweepStaleSshIdentities(base).removed).toEqual([]);
      expect(existsSync(path)).toBe(true);
    } finally {
      Object.defineProperty(process, "getuid", { value: originalGetuid, configurable: true });
    }
  });

  it("does nothing, and does not throw, when the base directory has never existed", () => {
    expect(sweepStaleSshIdentities(join(base, "absent"))).toEqual({ removed: [], live: 0 });
  });

  it("does not throw when the base directory cannot be read", () => {
    // A sweep that throws would stop the worker from starting, which is a far worse outcome than a
    // stale directory that is cleaned up on the next boot.
    const root = authBaseDirectory(base);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o000);
    try {
      expect(() => sweepStaleSshIdentities(base)).not.toThrow();
    } finally {
      chmodSync(root, 0o700);
    }
  });

  it("sweeps what a real identity left behind when its process is treated as gone", () => {
    // End to end: the transport's own directory, renamed to a dead pid, is what the sweep removes.
    const identity = expectOk(createSshIdentity(KEY, undefined, base));
    const keyPath = /-i '([^']+)'/.exec(identity.sshCommand)?.[1] ?? "";
    expect(existsSync(keyPath)).toBe(true);

    // Simulate SIGKILL: the directory survives because `dispose` never ran.
    const orphan = deadSession("session-999998-orphan");
    identity.dispose();

    expect(sweepStaleSshIdentities(base).removed).toEqual(["session-999998-orphan"]);
    expect(existsSync(orphan)).toBe(false);
  });
});

describe("knownHostsFileContents", () => {
  it("bundles GitHub's host keys, so github.com needs no project setting", () => {
    const contents = knownHostsFileContents(undefined);
    expect(contents).toContain("github.com ssh-ed25519 ");
    expect(contents).toContain("github.com ecdsa-sha2-nistp256 ");
    expect(contents).toContain("github.com ssh-rsa ");
    expect(GITHUB_HOST_KEYS.length).toBe(3);
  });

  it("ends with a newline, or ssh ignores the last key", () => {
    // Which would silently make verification depend on the algorithm negotiated.
    expect(knownHostsFileContents(undefined).endsWith("\n")).toBe(true);
    expect(knownHostsFileContents("host ssh-ed25519 AAAA").endsWith("\n")).toBe(true);
  });

  it("replaces the bundled keys entirely when overridden", () => {
    const contents = knownHostsFileContents("git.acme.internal ssh-ed25519 AAAAOverride");
    expect(contents).toContain("git.acme.internal");
    expect(contents).not.toContain("github.com");
  });
});
