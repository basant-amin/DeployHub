// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectErr, expectOk } from "@/core/shared/result.testing";

import { FileSecretProvider } from "./file-secret-provider";
import { hasCredential, writeCredential } from "./secret-file-writer";

const KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n`;

let directory: string;
let store: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "deployhub-secrets-"));
  store = join(directory, "secrets.json");
  writeStore({ "other.git.credentials": "keep-me", "other.runtime.env": { PORT: "3000" } });
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function writeStore(contents: Readonly<Record<string, unknown>>): void {
  writeFileSync(store, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
  chmodSync(store, 0o600);
}

function readStore(): Record<string, unknown> {
  return JSON.parse(readFileSync(store, "utf8")) as Record<string, unknown>;
}

describe("writeCredential", () => {
  it("adds an entry without disturbing the others", () => {
    const report = expectOk(writeCredential(store, "demo.git.credentials", KEY));

    expect(report.replaced).toBe(false);
    const after = readStore();
    expect(after["demo.git.credentials"]).toBe(KEY);
    expect(after["other.git.credentials"]).toBe("keep-me");
    expect(after["other.runtime.env"]).toEqual({ PORT: "3000" });
  });

  it("writes something the platform's own reader accepts", async () => {
    // The point of the writer is that the next deployment can read what it wrote, so the assertion
    // goes through `FileSecretProvider` rather than through JSON.parse.
    expectOk(writeCredential(store, "demo.git.credentials", KEY));

    const resolved = await new FileSecretProvider(store).resolveCredential(
      "demo.git.credentials" as never,
    );
    expect(expectOk(resolved)).toBe(KEY);
  });

  it("keeps the store at 0600, which the provider refuses to read without", () => {
    expectOk(writeCredential(store, "demo.git.credentials", KEY));
    expect(statSync(store).mode & 0o777).toBe(0o600);
  });

  it("leaves no temporary file behind", () => {
    expectOk(writeCredential(store, "demo.git.credentials", KEY));
    expect(readdirSync(directory)).toEqual(["secrets.json"]);
  });

  it("refuses to replace an existing entry", () => {
    // Overwriting a deploy key invalidates the public key registered on the repository, and every
    // deployment then fails until someone works out why. That has to be a decision.
    const error = expectErr(writeCredential(store, "other.git.credentials", KEY));

    expect(error.code).toBe("SECRET_STORE_UNAVAILABLE");
    expect(error.message).toContain("--force");
    expect(readStore()["other.git.credentials"]).toBe("keep-me");
  });

  it("replaces it with --force, and says that it did", () => {
    const report = expectOk(writeCredential(store, "other.git.credentials", KEY, { force: true }));

    expect(report.replaced).toBe(true);
    expect(readStore()["other.git.credentials"]).toBe(KEY);
  });

  it("keeps no copy of the value it replaced", () => {
    // A second private key at rest is a worse risk than the rotation window, and GitHub allows
    // adding the new deploy key before removing the old one.
    expectOk(writeCredential(store, "other.git.credentials", KEY, { force: true }));
    expect(readFileSync(store, "utf8")).not.toContain("keep-me");
  });

  it("rejects an invalid secret reference before touching the store", () => {
    const error = expectErr(writeCredential(store, "Not A Ref!", KEY));

    expect(error.code).toBe("SECRET_REF_INVALID");
    expect(readStore()).not.toHaveProperty("Not A Ref!");
  });

  it("refuses an empty credential", () => {
    expect(writeCredential(store, "demo.git.credentials", "   ").ok).toBe(false);
  });

  it("refuses a store the wrong people can read", () => {
    chmodSync(store, 0o644);
    const error = expectErr(writeCredential(store, "demo.git.credentials", KEY));

    expect(error.code).toBe("SECRET_STORE_UNAVAILABLE");
    expect(error.message).toContain("0600");
  });

  it("refuses a store that does not exist rather than inventing one", () => {
    // Creating it would mean guessing at owner and mode, and a secrets file with the wrong owner is
    // exactly what the startup check exists to report. install.sh and dev:prepare own that decision.
    const error = expectErr(writeCredential(join(directory, "absent.json"), "demo.git.creds", KEY));

    expect(error.code).toBe("SECRET_STORE_UNAVAILABLE");
    expect(error.message).toContain("dev:prepare");
  });

  it("refuses a store that is not valid JSON, without quoting its contents", () => {
    writeFileSync(store, "{ this is not json", { mode: 0o600 });
    const error = expectErr(writeCredential(store, "demo.git.credentials", KEY));

    expect(error.message).toContain("not valid JSON");
    // The file holds secrets; a parse error can quote them.
    expect(error.message).not.toContain("this is not json");
  });

  it("does not corrupt the store when the write fails", () => {
    // The store is the only copy of every project's credentials and there is no backup, so a
    // half-written file is the worst possible outcome. Writing goes temp-file-then-rename for this.
    chmodSync(directory, 0o500);
    try {
      expect(writeCredential(store, "demo.git.credentials", KEY).ok).toBe(false);
      expect(readStore()["other.git.credentials"]).toBe("keep-me");
    } finally {
      chmodSync(directory, 0o700);
    }
  });
});

describe("hasCredential", () => {
  it("reports presence without reading the value out", () => {
    expect(expectOk(hasCredential(store, "other.git.credentials" as never))).toBe(true);
    expect(expectOk(hasCredential(store, "absent.git.credentials" as never))).toBe(false);
  });
});
