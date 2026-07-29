/**
 * `BuildArgs` — non-secret values passed to the image build.
 *
 * Validates names and value types only. Screening names for secret-looking words was
 * tried and removed: it is platform policy rather than a domain invariant, it has no
 * escape hatch for a legitimate `TOKEN_BUDGET`, and a value object is the wrong place
 * for a rule that a operator may need to override. The obligation it was protecting —
 * secrets reach a build through a `SecretRef`, never through this map, because a build
 * arg persists in image history forever — belongs in the build step and its
 * documentation.
 */

import { type Result, asRecord, checkCrossField, ok } from "@/core/shared";

const MAX_ARGS = 64;
const MAX_VALUE_LENGTH = 4096;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN_VALUE_CHARACTERS = /\u0000/;

export class BuildArgs {
  static readonly EMPTY = new BuildArgs(Object.freeze({}));

  private constructor(readonly entries: Readonly<Record<string, string>>) {}

  static create(raw: unknown): Result<BuildArgs> {
    if (raw === undefined || raw === null) {
      return ok(BuildArgs.EMPTY);
    }

    const record = asRecord(raw, "BUILD_ARGS_INVALID", "Build args");
    if (!record.ok) {
      return record;
    }

    const issues: string[] = [];
    const entries: Record<string, string> = {};
    const names = Object.keys(record.value);

    if (names.length > MAX_ARGS) {
      issues.push(`at most ${MAX_ARGS} build args are allowed (received ${names.length})`);
    }

    for (const name of names) {
      const value = record.value[name];

      if (!NAME_PATTERN.test(name)) {
        issues.push(
          `"${name}" is not a valid build arg name: use letters, digits, and underscores, not starting with a digit`,
        );
        continue;
      }
      if (typeof value !== "string") {
        issues.push(`"${name}" must be a string`);
        continue;
      }
      if (value.length > MAX_VALUE_LENGTH) {
        issues.push(`"${name}" exceeds ${MAX_VALUE_LENGTH} characters`);
        continue;
      }
      if (FORBIDDEN_VALUE_CHARACTERS.test(value)) {
        issues.push(`"${name}" must not contain NUL bytes`);
        continue;
      }

      entries[name] = value;
    }

    return checkCrossField(
      "BUILD_ARGS_INVALID",
      "Invalid build args",
      new BuildArgs(Object.freeze(entries)),
      issues,
    );
  }

  get size(): number {
    return Object.keys(this.entries).length;
  }

  get isEmpty(): boolean {
    return this.size === 0;
  }

  get(name: string): string | undefined {
    return this.entries[name];
  }

  toJSON(): Readonly<Record<string, string>> {
    return this.entries;
  }
}
