// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectErr, expectOk } from "@/core/shared/result.testing";

import { LocalCommandRunner } from "../command-runner";
import { derivePublicKey, generateDeployKey } from "./deploy-key";
import { authBaseDirectory, looksLikePrivateKey } from "./ssh-key";

/**
 * Driven against the real `ssh-keygen`, deliberately. The whole reason this module shells out rather
 * than using `node:crypto` is that GitHub needs OpenSSH's exact formats, and a fake runner returning
 * strings I typed would assert nothing about that.
 */

const runner = new LocalCommandRunner();

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "deployhub-keygen-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("generateDeployKey", () => {
  it("produces a key pair in the formats GitHub and OpenSSH require", async () => {
    const pair = expectOk(await generateDeployKey(runner, "deployhub:demo.git.credentials", base));

    expect(looksLikePrivateKey(pair.privateKey)).toBe(true);
    // The authorized-keys form, which is what the Deploy keys screen accepts.
    expect(pair.publicKey).toMatch(
      /^ssh-ed25519 [A-Za-z0-9+/]+=* deployhub:demo\.git\.credentials$/,
    );
  });

  it("leaves nothing on disk", async () => {
    // The private key exists as a file for as long as ssh-keygen takes to write it and this module
    // takes to read it. After that it lives only in the secret store.
    expectOk(await generateDeployKey(runner, "deployhub:demo.git.credentials", base));

    expect(readdirSync(authBaseDirectory(base))).toEqual([]);
  });

  it("generates a distinct key every time", async () => {
    const first = expectOk(await generateDeployKey(runner, "deployhub:a", base));
    const second = expectOk(await generateDeployKey(runner, "deployhub:b", base));

    expect(second.privateKey).not.toBe(first.privateKey);
    expect(second.publicKey).not.toBe(first.publicKey);
  });

  it("reports a failure without leaving a directory behind", async () => {
    const failing = {
      run: async () => ok0(),
    };
    const error = expectErr(await generateDeployKey(failing, "deployhub:demo", base));

    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toContain("ssh-keygen");
    expect(existsSync(authBaseDirectory(base)) ? readdirSync(authBaseDirectory(base)) : []).toEqual(
      [],
    );
  });
});

describe("derivePublicKey", () => {
  it("recovers the public half from a stored private key", async () => {
    // So that losing the printed public key never means rotating a working deploy key.
    const pair = expectOk(await generateDeployKey(runner, "deployhub:demo", base));
    const derived = expectOk(
      await derivePublicKey(runner, pair.privateKey, "deployhub:demo", base),
    );

    expect(derived).toBe(pair.publicKey);
  });

  it("leaves nothing on disk", async () => {
    const pair = expectOk(await generateDeployKey(runner, "deployhub:demo", base));
    expectOk(await derivePublicKey(runner, pair.privateKey, "deployhub:demo", base));

    expect(readdirSync(authBaseDirectory(base))).toEqual([]);
  });

  it("refuses an entry that is not a private key, before writing anything", async () => {
    const error = expectErr(
      await derivePublicKey(runner, "ghp_0123456789abcdefghij", "deployhub:demo", base),
    );

    expect(error.code).toBe("PREFLIGHT_CREDENTIAL_MISSING");
    expect(existsSync(authBaseDirectory(base))).toBe(false);
  });
});

/** A runner whose command exits non-zero, as `ssh-keygen` would on a bad invocation. */
function ok0() {
  return { ok: true as const, value: { exitCode: 1, stdout: "", stderr: "unknown option" } };
}
