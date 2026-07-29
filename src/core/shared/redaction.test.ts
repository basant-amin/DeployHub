// @vitest-environment node
import { describe, expect, it } from "vitest";

import { DEFAULT_REDACTION_RULES, REDACTED, Redactor, redact } from "./redaction";

/**
 * The governing assertion of this suite: for every input, the secret must not appear
 * anywhere in the output. Checking "was something replaced" is not enough — the
 * defect this suite exists to prevent was a rule that redacted the first word of a
 * multi-word password and left the rest in the log.
 */
function expectFullyRedacted(input: string, secret: string): string {
  const output = redact(input);
  expect(output, `secret survived in: ${output}`).not.toContain(secret);
  expect(output).toContain(REDACTED);
  return output;
}

describe("quoted assignments", () => {
  it("redacts a double-quoted multi-word value", () => {
    expect(expectFullyRedacted('password="two words"', "two words")).toBe(`password="${REDACTED}"`);
  });

  it("redacts a single-quoted multi-word value", () => {
    expect(expectFullyRedacted("password='two words'", "two words")).toBe(`password='${REDACTED}'`);
  });

  it("redacts a backtick-quoted value", () => {
    expectFullyRedacted("export SECRET=`two words`", "two words");
  });

  it("keeps the quotes so the shape of the log line survives", () => {
    expect(redact('token="abc"')).toBe(`token="${REDACTED}"`);
  });

  it("redacts a value containing punctuation, spaces, and equals signs", () => {
    expectFullyRedacted('password="p@ss w0rd = yes; really"', "p@ss w0rd = yes; really");
  });

  it("redacts only the value, leaving following pairs intact", () => {
    const output = expectFullyRedacted('password="two words", user="bob"', "two words");
    expect(output).toContain('user="bob"');
  });
});

describe("JSON-style assignments", () => {
  it("redacts a quoted JSON value", () => {
    const output = expectFullyRedacted('{"password": "two words"}', "two words");
    expect(output).toBe(`{"password": "${REDACTED}"}`);
  });

  it("redacts a compact JSON value", () => {
    expect(expectFullyRedacted('{"token":"abcdef"}', "abcdef")).toBe(`{"token":"${REDACTED}"}`);
  });

  it("redacts each secret in a JSON object and leaves the rest", () => {
    const output = redact('{"apiKey":"k1 k2","actor":"basant","secret":"s1 s2"}');
    expect(output).not.toContain("k1 k2");
    expect(output).not.toContain("s1 s2");
    expect(output).toContain('"actor":"basant"');
  });

  it("redacts an unquoted JSON-ish value", () => {
    expectFullyRedacted('{"token": abcdef}', "abcdef");
  });
});

describe("unquoted and multi-word values", () => {
  it("redacts every word of a multi-word value", () => {
    expect(expectFullyRedacted("token: abc def", "abc def")).toBe(`token: ${REDACTED}`);
    expect(redact("token: abc def")).not.toContain("def");
  });

  it("redacts a simple assignment", () => {
    expect(expectFullyRedacted("DB_PASSWORD=hunter2secret", "hunter2secret")).toBe(
      `DB_PASSWORD=${REDACTED}`,
    );
  });

  it("redacts an Authorization header including its scheme and multi-part value", () => {
    expectFullyRedacted("Authorization: Bearer abc def ghi", "abc def ghi");
  });

  it("stops at a comma so neighbouring pairs survive", () => {
    const output = expectFullyRedacted("password=first secret,user=bob", "first secret");
    expect(output).toBe(`password=${REDACTED},user=bob`);
  });

  it("stops at a semicolon", () => {
    expect(expectFullyRedacted("token=abcdef;path=/", "abcdef")).toBe(`token=${REDACTED};path=/`);
  });

  it("stops at an ampersand in a query string", () => {
    const output = expectFullyRedacted("/cb?password=hunter2&user=bob", "hunter2");
    expect(output).toBe(`/cb?password=${REDACTED}&user=bob`);
  });

  it("stops at a line break so the next log line is untouched", () => {
    const output = expectFullyRedacted("token: abc def\nStep 5/9 : RUN build", "abc def");
    expect(output).toContain("Step 5/9 : RUN build");
  });

  it("matches a key with a prefix or a hyphen, keeping the prefix", () => {
    expect(redact("X-Auth-Token: abcdefgh")).toBe(`X-Auth-Token: ${REDACTED}`);
    expect(redact("api_key = abcdefgh")).toBe(`api_key = ${REDACTED}`);
    expect(redact("AWS_SECRET_ACCESS_KEY=abcdefgh")).toContain(REDACTED);
  });
});

describe("credentials with no key name", () => {
  it("redacts the password out of a URL but keeps the user", () => {
    const output = expectFullyRedacted(
      "cloning https://deploy:hunter2pass@github.com/x.git",
      "hunter2pass",
    );
    expect(output).toContain("deploy:");
    expect(output).toContain("github.com/x.git");
  });

  it("removes a private key block whole", () => {
    const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----";
    expect(expectFullyRedacted(`key: ${key}`, "abc\ndef")).toBe(`key: ${REDACTED}`);
  });

  it("recognizes well-known token shapes", () => {
    expect(redact(`ghp_${"a".repeat(20)}`)).toBe(REDACTED);
    expect(redact(`AKIA${"A".repeat(16)}`)).toBe(REDACTED);
    expect(redact(`xoxb-${"1".repeat(12)}`)).toBe(REDACTED);
    expect(redact(`eyJ${"a".repeat(10)}.${"b".repeat(10)}.${"c".repeat(10)}`)).toBe(REDACTED);
  });
});

describe("known secret values", () => {
  it("removes a resolved secret wherever it appears, in any shape", () => {
    const redactor = Redactor.create(["s3cr3t-value"]);
    expect(redactor.redact("echo s3cr3t-value | wc -c")).toBe(`echo ${REDACTED} | wc -c`);
    expect(redactor.redact("prefix-s3cr3t-value-suffix")).toBe(`prefix-${REDACTED}-suffix`);
  });

  it("replaces the longest match first so an overlapping secret is not left partial", () => {
    const redactor = Redactor.create(["s3cr3t-value", "s3cr3t"]);
    expect(redactor.redact("token is s3cr3t-value here")).toBe(`token is ${REDACTED} here`);
  });

  it("ignores values too short to be credentials", () => {
    expect(Redactor.create(["ab"]).knownSecretCount).toBe(0);
    expect(Redactor.create(["  x  "]).knownSecretCount).toBe(0);
  });

  it("deduplicates", () => {
    expect(Redactor.create(["hunter2pass", "hunter2pass"]).knownSecretCount).toBe(1);
  });
});

describe("safety properties", () => {
  it("is idempotent — redacting twice changes nothing further", () => {
    for (const input of [
      'password="two words"',
      "token: abc def",
      "DB_PASSWORD=hunter2secret",
      '{"apiKey":"k1 k2"}',
      "https://u:hunter2pass@example.com/r.git",
    ]) {
      const once = redact(input);
      expect(redact(once), input).toBe(once);
    }
  });

  it("leaves ordinary build output untouched", () => {
    for (const line of [
      "Step 4/9 : COPY package.json ./",
      "added 412 packages in 9s",
      "GET /healthz 200 3ms",
      "tokenizer initialized",
      "secretName is not a credential key",
    ]) {
      expect(redact(line), line).toBe(line);
    }
  });

  it("never throws, whatever it is handed", () => {
    const redactor = Redactor.create(["hunter2pass"]);
    expect(redactor.redactUnknown({ password: "hunter2pass" })).toContain(REDACTED);
    expect(redactor.redactUnknown(new Error("hunter2pass leaked"))).toContain(REDACTED);
    expect(() => redactor.redactUnknown(undefined)).not.toThrow();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => redactor.redactUnknown(circular)).not.toThrow();
  });

  /**
   * Redaction runs over untrusted build output, where a single 40,000-character
   * minified line is routine. Every pattern must therefore scan in time linear in the
   * line length. An unbounded quantifier over a character class that excludes the
   * terminator is the trap: the engine consumes to the end of the line and then
   * backtracks from every start position, which was measured at 848ms for 40,000
   * characters before the URL rule's segments were length-bounded.
   *
   * The bound below is ~40x the linear cost, so ordinary machine noise cannot fail it,
   * while a regression to quadratic cannot pass it.
   */
  it("scans a long line in linear time", () => {
    for (const input of [
      `password="${"a".repeat(40_000)}`, // an unterminated quoted value
      `https://user:${"a".repeat(40_000)}`, // credentials with no terminating @
      "a".repeat(40_000), // no secret at all
      `token: ${"a".repeat(40_000)}`,
    ]) {
      const started = performance.now();
      redact(input);
      expect(performance.now() - started, input.slice(0, 24)).toBeLessThan(200);
    }
  });

  it("still redacts a long value it can delimit", () => {
    const secret = "a".repeat(4_000);
    expect(redact(`password="${secret}"`)).not.toContain(secret);
    expect(redact(`https://user:${secret}@host/x.git`)).not.toContain(secret);
  });

  it("exposes its rules for review, most specific first", () => {
    expect(DEFAULT_REDACTION_RULES[0]?.name).toBe("pem-private-key");
    expect(DEFAULT_REDACTION_RULES.map((r) => r.name)).toContain("quoted-assignment");
    expect(Object.isFrozen(DEFAULT_REDACTION_RULES)).toBe(true);
  });
});
