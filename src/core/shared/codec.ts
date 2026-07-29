/**
 * Codec factories for branded primitives.
 *
 * Generating a value object from a spec keeps each one to a two-line declaration, so
 * adding one is cheap enough that nobody is tempted to pass a bare `string` instead.
 */

import type { Result } from "./result";
import { type IntegerSpec, type StringSpec, parseInteger, parseString } from "./validation";

export interface Codec<T> {
  /** Validate and brand. Normalization (trim, case) is applied by the spec. */
  parse(raw: unknown): Result<T>;
}

export function brandedString<T extends string>(spec: StringSpec): Codec<T> {
  return {
    parse(raw: unknown): Result<T> {
      return parseString(raw, spec) as Result<T>;
    },
  };
}

export function brandedInteger<T extends number>(spec: IntegerSpec): Codec<T> {
  return {
    parse(raw: unknown): Result<T> {
      return parseInteger(raw, spec) as Result<T>;
    },
  };
}
