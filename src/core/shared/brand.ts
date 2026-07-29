/**
 * Nominal typing for primitives.
 *
 * A branded type is structurally its underlying primitive — a `CommitSha` is a
 * `string` and can be interpolated, compared with `===`, and serialized as one —
 * but it cannot be produced by assignment. The only way to obtain one is through
 * the validating parser that brands it, so possessing the type is proof that the
 * value was validated.
 *
 * This is what stops the domain from degenerating into functions that take five
 * `string` parameters, where transposing two arguments type-checks cleanly and
 * fails in production.
 */

declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };
