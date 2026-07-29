import { describe, expect, it } from "vitest";

import { EnvValidationError, parseEnv } from "@/config/env";

const valid = {
  NODE_ENV: "production",
  NEXT_PUBLIC_APP_URL: "https://deployhub.example.com",
} as const;

describe("parseEnv", () => {
  it("accepts a valid environment", () => {
    const env = parseEnv({ ...valid });
    expect(env.NODE_ENV).toBe("production");
    expect(env.NEXT_PUBLIC_APP_URL).toBe("https://deployhub.example.com");
  });

  it("defaults NODE_ENV to development when unset", () => {
    expect(parseEnv({ NEXT_PUBLIC_APP_URL: valid.NEXT_PUBLIC_APP_URL }).NODE_ENV).toBe(
      "development",
    );
  });

  it("returns a frozen object", () => {
    const env = parseEnv({ ...valid });
    expect(Object.isFrozen(env)).toBe(true);
  });

  it("rejects an invalid NODE_ENV", () => {
    expect(() => parseEnv({ ...valid, NODE_ENV: "staging" })).toThrow(EnvValidationError);
  });

  it("rejects a missing app URL", () => {
    expect(() => parseEnv({ NODE_ENV: "production" })).toThrow(/NEXT_PUBLIC_APP_URL is required/);
  });

  it("rejects a non-http app URL", () => {
    expect(() => parseEnv({ ...valid, NEXT_PUBLIC_APP_URL: "ftp://nope" })).toThrow(
      /valid http\(s\) URL/,
    );
  });
});
