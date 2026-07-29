import { describe, expect, it } from "vitest";

import { expectedToken, isConfigured, tokensMatch } from "./session";

describe("isConfigured", () => {
  it("refuses an unset password", () => {
    expect(isConfigured(undefined)).toBe(false);
  });

  it("refuses a password short enough to guess", () => {
    expect(isConfigured("")).toBe(false);
    expect(isConfigured("hunter2")).toBe(false);
  });

  it("accepts eight characters and up", () => {
    expect(isConfigured("hunter22")).toBe(true);
  });
});

describe("expectedToken", () => {
  it("is a hex SHA-256 digest", async () => {
    expect(await expectedToken("correct horse battery")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across calls, so a session survives a restart of DeployHub", async () => {
    const first = await expectedToken("correct horse battery");
    const second = await expectedToken("correct horse battery");
    expect(second).toBe(first);
  });

  it("differs for a different password", async () => {
    const a = await expectedToken("correct horse battery");
    const b = await expectedToken("correct horse batterz");
    expect(b).not.toBe(a);
  });

  it("does not contain the password", async () => {
    const token = await expectedToken("correct horse battery");
    expect(token).not.toContain("correct");
  });
});

describe("tokensMatch", () => {
  it("matches an identical value", () => {
    expect(tokensMatch("abc123", "abc123")).toBe(true);
  });

  it("rejects a missing cookie", () => {
    expect(tokensMatch(undefined, "abc123")).toBe(false);
  });

  it("rejects a different length without indexing past the end", () => {
    expect(tokensMatch("abc", "abc123")).toBe(false);
    expect(tokensMatch("abc1234", "abc123")).toBe(false);
  });

  it("rejects a value that differs only in the last character", () => {
    expect(tokensMatch("abc124", "abc123")).toBe(false);
  });

  it("rejects a value that differs only in the first character", () => {
    expect(tokensMatch("zbc123", "abc123")).toBe(false);
  });
});
