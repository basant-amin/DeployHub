// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runtimeConfigFromEnv } from "./composition";
import {
  DevSetupError,
  defaultDevRoot,
  ensureDevEnvFile,
  generateLocalPassword,
  prepareDevRoot,
  readEnvValue,
} from "./dev-root";
import { checkRuntime } from "./startup-check";

let scratch: string;

/** A fixed password, so no test depends on randomness. */
const password = () => "0123456789abcdef0123456789abcdef0123456789abcdef";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "deployhub-dev-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("defaultDevRoot", () => {
  it("is an absolute path under the home directory, and names no user", () => {
    expect(defaultDevRoot("/Users/someone")).toBe("/Users/someone/.deployhub-dev");
  });
});

describe("prepareDevRoot", () => {
  it("creates the three paths the startup check requires", () => {
    const root = join(scratch, "runtime");
    const report = prepareDevRoot(root);

    expect(statSync(root).isDirectory()).toBe(true);
    expect(statSync(join(root, "projects")).isDirectory()).toBe(true);
    expect(readFileSync(join(root, "secrets.json"), "utf8")).toBe("{}\n");
    expect(report.changed).toHaveLength(3);
  });

  it("writes the secrets file at 600, which is the only mode the provider will read", () => {
    const root = join(scratch, "runtime");
    prepareDevRoot(root);
    expect(modeOf(join(root, "secrets.json"))).toBe(0o600);
  });

  it("changes nothing on a second run", () => {
    const root = join(scratch, "runtime");
    prepareDevRoot(root);
    const second = prepareDevRoot(root);

    expect(second.changed).toEqual([]);
    expect(second.already).toHaveLength(3);
  });

  it("never overwrites an existing secrets file", () => {
    const root = join(scratch, "runtime");
    prepareDevRoot(root);
    writeFileSync(join(root, "secrets.json"), '{"github":"real-token"}', { mode: 0o600 });

    prepareDevRoot(root);

    expect(readFileSync(join(root, "secrets.json"), "utf8")).toBe('{"github":"real-token"}');
  });

  it("tightens a secrets file left group-readable", () => {
    const root = join(scratch, "runtime");
    prepareDevRoot(root);
    chmodSync(join(root, "secrets.json"), 0o644);

    const report = prepareDevRoot(root);

    expect(modeOf(join(root, "secrets.json"))).toBe(0o600);
    expect(report.changed).toEqual([expect.stringContaining("chmod 600")]);
  });

  it("refuses a system directory, because those belong to the installer", () => {
    for (const root of ["/var/lib/deployhub", "/etc/deployhub", "/usr/local/deployhub"]) {
      expect(() => prepareDevRoot(root)).toThrow(DevSetupError);
      expect(() => prepareDevRoot(root)).toThrow(/system directory/);
    }
  });

  it("refuses a relative path, which would differ per process", () => {
    expect(() => prepareDevRoot(".deployhub")).toThrow(/absolute/);
  });

  it("refuses to run as root, which is the failure the startup check reports", () => {
    expect(() => prepareDevRoot(join(scratch, "runtime"), { uid: 0 })).toThrow(/as root/);
  });

  it("refuses a path too shallow to be a data directory", () => {
    expect(() => prepareDevRoot("/deployhub")).toThrow(/nested path/);
  });

  it("refuses a root that exists as a file", () => {
    const root = join(scratch, "occupied");
    writeFileSync(root, "");
    expect(() => prepareDevRoot(root)).toThrow(/not a directory/);
  });
});

describe("a prepared dev root", () => {
  /**
   * The assertion that holds the two halves together. `dev:prepare` exists solely to satisfy
   * `checkRuntime`, so if either side changes shape without the other, this fails.
   */
  it("satisfies the startup check, with no problem left to report", () => {
    const root = join(scratch, "runtime");
    prepareDevRoot(root);

    const config = runtimeConfigFromEnv({ ...process.env, DEPLOYHUB_ROOT: root });
    expect(checkRuntime(config, { dockerSocket: undefined })).toEqual([]);
  });
});

describe("readEnvValue", () => {
  it("reads a value", () => {
    expect(readEnvValue("DEPLOYHUB_ROOT=/home/dev/.deployhub-dev\n", "DEPLOYHUB_ROOT")).toBe(
      "/home/dev/.deployhub-dev",
    );
  });

  it("ignores comments, blank lines, and other keys", () => {
    const contents = "# DEPLOYHUB_ROOT=/wrong\n\nOTHER=1\nDEPLOYHUB_ROOT=/right\n";
    expect(readEnvValue(contents, "DEPLOYHUB_ROOT")).toBe("/right");
  });

  it("strips surrounding quotes", () => {
    expect(readEnvValue('DEPLOYHUB_ROOT="/quoted/path"\n', "DEPLOYHUB_ROOT")).toBe("/quoted/path");
  });

  it("treats an empty value as unset, because that is what .env.example ships", () => {
    expect(readEnvValue("DEPLOYHUB_ROOT=\n", "DEPLOYHUB_ROOT")).toBeUndefined();
    expect(readEnvValue("DEPLOYHUB_PASSWORD=   \n", "DEPLOYHUB_PASSWORD")).toBeUndefined();
  });
});

describe("ensureDevEnvFile", () => {
  it("writes a complete file when there is none", () => {
    const path = join(scratch, ".env.local");
    const report = ensureDevEnvFile(path, "/home/dev/.deployhub-dev", password);
    const contents = readFileSync(path, "utf8");

    expect(report.created).toBe(true);
    expect(readEnvValue(contents, "DEPLOYHUB_ROOT")).toBe("/home/dev/.deployhub-dev");
    expect(readEnvValue(contents, "DEPLOYHUB_PASSWORD")).toBe(password());
    expect(readEnvValue(contents, "DEPLOYHUB_PUBLIC_SCHEME")).toBe("http");
  });

  it("writes it at 600: it holds a password", () => {
    const path = join(scratch, ".env.local");
    ensureDevEnvFile(path, "/home/dev/.deployhub-dev", password);
    expect(modeOf(path)).toBe(0o600);
  });

  it("leaves a developer's own values alone", () => {
    const path = join(scratch, ".env.local");
    writeFileSync(path, "DEPLOYHUB_ROOT=/my/own/root\nDEPLOYHUB_PASSWORD=mine-not-yours\n");

    const report = ensureDevEnvFile(path, "/home/dev/.deployhub-dev", password);
    const contents = readFileSync(path, "utf8");

    expect(report.added).toEqual([]);
    expect(report.already).toEqual(["DEPLOYHUB_ROOT", "DEPLOYHUB_PASSWORD"]);
    expect(readEnvValue(contents, "DEPLOYHUB_ROOT")).toBe("/my/own/root");
    expect(readEnvValue(contents, "DEPLOYHUB_PASSWORD")).toBe("mine-not-yours");
  });

  it("appends only what is missing", () => {
    const path = join(scratch, ".env.local");
    writeFileSync(path, "DEPLOYHUB_PASSWORD=mine-not-yours\n");

    const report = ensureDevEnvFile(path, "/home/dev/.deployhub-dev", password);
    const contents = readFileSync(path, "utf8");

    expect(report.added).toEqual(["DEPLOYHUB_ROOT"]);
    expect(readEnvValue(contents, "DEPLOYHUB_ROOT")).toBe("/home/dev/.deployhub-dev");
    expect(readEnvValue(contents, "DEPLOYHUB_PASSWORD")).toBe("mine-not-yours");
  });

  it("does not report the password it generated", () => {
    const path = join(scratch, ".env.local");
    const report = ensureDevEnvFile(path, "/home/dev/.deployhub-dev", password);
    expect(JSON.stringify(report)).not.toContain(password());
  });
});

describe("generateLocalPassword", () => {
  it("clears the minimum the session requires, by a wide margin", () => {
    expect(generateLocalPassword()).toMatch(/^[0-9a-f]{48}$/);
  });

  it("differs every time, so no two machines share one", () => {
    expect(generateLocalPassword()).not.toBe(generateLocalPassword());
  });
});
