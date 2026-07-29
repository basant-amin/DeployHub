/**
 * Validation primitives shared by every value object.
 *
 * Two things live here. `parseString` / `parseInteger` centralize the mechanical
 * checks — trimming, length, charset, range — so twenty value objects do not each
 * reimplement them slightly differently. `combineFields` validates a composite by
 * reporting **every** bad field at once rather than stopping at the first, because
 * a configuration screen that reveals one error per attempt is a bad screen.
 */

import { DeploymentError } from "./errors";
import type { ErrorCode } from "./error-codes";
import { type Result, err, ok } from "./result";

export interface StringSpec {
  /** Human-readable field name, used verbatim in messages. */
  readonly label: string;
  readonly code: ErrorCode;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: RegExp;
  /** What `pattern` means, in words. Regex source is not an error message. */
  readonly patternHint?: string;
  /**
   * A rule too involved for a readable regex (git ref syntax, path traversal).
   * Applied after `pattern`.
   */
  readonly predicate?: (value: string) => boolean;
  /** What `predicate` means, in words. Required to be useful when one is set. */
  readonly predicateHint?: string;
  /** Trim surrounding whitespace before validating. Defaults to `true`. */
  readonly trim?: boolean;
  /** Lowercase before validating. Off by default. */
  readonly lowercase?: boolean;
}

export function parseString(raw: unknown, spec: StringSpec): Result<string> {
  if (typeof raw !== "string") {
    return err(DeploymentError.of(spec.code, `${spec.label} must be a string`));
  }

  let value = spec.trim === false ? raw : raw.trim();
  if (spec.lowercase === true) {
    value = value.toLowerCase();
  }

  const min = spec.minLength ?? 1;
  if (value.length < min) {
    return err(
      DeploymentError.of(
        spec.code,
        min === 1
          ? `${spec.label} must not be empty`
          : `${spec.label} must be at least ${min} characters`,
      ),
    );
  }

  if (spec.maxLength !== undefined && value.length > spec.maxLength) {
    return err(
      DeploymentError.of(
        spec.code,
        `${spec.label} must be at most ${spec.maxLength} characters (received ${value.length})`,
      ),
    );
  }

  if (spec.pattern !== undefined && !spec.pattern.test(value)) {
    const hint = spec.patternHint ?? `match ${String(spec.pattern)}`;
    return err(DeploymentError.of(spec.code, `${spec.label} must ${hint}`));
  }

  if (spec.predicate !== undefined && !spec.predicate(value)) {
    const hint = spec.predicateHint ?? "be valid";
    return err(DeploymentError.of(spec.code, `${spec.label} must ${hint}`));
  }

  return ok(value);
}

/**
 * Narrow an unknown value to a property bag.
 *
 * Composite value objects accept `unknown` so they can validate a row from the
 * database or a parsed JSON body with the same code path that validates a literal
 * from a caller — there is no second, more trusting way in.
 */
export function asRecord(
  raw: unknown,
  code: ErrorCode,
  label: string,
): Result<Readonly<Record<string, unknown>>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return err(DeploymentError.of(code, `${label} must be an object`));
  }
  return ok(raw as Readonly<Record<string, unknown>>);
}

export interface IntegerSpec {
  readonly label: string;
  readonly code: ErrorCode;
  readonly min?: number;
  readonly max?: number;
}

export function parseInteger(raw: unknown, spec: IntegerSpec): Result<number> {
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    return err(DeploymentError.of(spec.code, `${spec.label} must be an integer`));
  }
  if (spec.min !== undefined && raw < spec.min) {
    return err(DeploymentError.of(spec.code, `${spec.label} must be at least ${spec.min}`));
  }
  if (spec.max !== undefined && raw > spec.max) {
    return err(DeploymentError.of(spec.code, `${spec.label} must be at most ${spec.max}`));
  }
  return ok(raw);
}

type FieldResults = Readonly<Record<string, Result<unknown>>>;

type UnwrapFields<T extends FieldResults> = {
  readonly [K in keyof T]: T[K] extends Result<infer V> ? V : never;
};

/**
 * Validate independent fields together, reporting every failure.
 *
 * Each field's error contributes one issue per underlying problem, prefixed with
 * the field name, so a nested composite's issues survive with a readable path.
 */
export function combineFields<T extends FieldResults>(
  code: ErrorCode,
  message: string,
  fields: T,
): Result<UnwrapFields<T>> {
  const issues: string[] = [];
  const values: Record<string, unknown> = {};

  for (const [key, result] of Object.entries(fields)) {
    if (result.ok) {
      values[key] = result.value;
      continue;
    }
    if (result.error.issues.length > 0) {
      for (const issue of result.error.issues) {
        issues.push(`${key}.${issue}`);
      }
    } else {
      issues.push(`${key}: ${result.error.message}`);
    }
  }

  if (issues.length > 0) {
    return err(DeploymentError.validation(code, message, issues));
  }

  return ok(values as UnwrapFields<T>);
}

/**
 * Fail with a set of cross-field issues, or pass the already-validated fields
 * through. Used for the rules a per-field check cannot express.
 */
export function checkCrossField<T>(
  code: ErrorCode,
  message: string,
  value: T,
  issues: readonly string[],
): Result<T> {
  return issues.length > 0 ? err(DeploymentError.validation(code, message, issues)) : ok(value);
}
