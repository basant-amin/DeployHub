/**
 * Test-only helpers for asserting on a `Result`.
 *
 * Not part of the production surface — nothing outside a test imports this. It exists
 * so the domain's test files do not each define their own copy of the same two
 * functions, and so a failure reports the error's code and message rather than
 * `expected true to be false`.
 */

import type { DeploymentError } from "./errors";
import type { Result } from "./result";

/** Assert success and return the value. */
export function expectOk<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

/** Assert failure and return the error. */
export function expectErr<T>(result: Result<T>): DeploymentError {
  if (result.ok) {
    throw new Error(`expected failure, got success: ${JSON.stringify(result.value)}`);
  }
  return result.error;
}
