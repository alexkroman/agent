// Copyright 2026 the AAI authors. MIT license.
/**
 * The compile-time half of a journal identity: a name that has not WIDENED.
 *
 * One type, split out of `sdk/workflow-ctx.ts` when the schema options took that
 * file to its 500-line cap. It is deliberately not exported from the package —
 * an author meets it as the message tsc prints, never by name — so it lives in an
 * internal module beside the type that applies it rather than on any subpath.
 *
 * @module
 */

/**
 * A string LITERAL — the same type, unless it has widened to `string`.
 *
 * `string extends S` is only true when `S` IS `string`, so a widened argument
 * resolves to `never` and the call site is a compile error naming the parameter.
 * That turns "make it a string LITERAL" from advice in a doc comment into
 * something the checker says.
 *
 * ## What it CANNOT catch, stated because the gap is the interesting part
 *
 * Determinism is a fact about how a value was PRODUCED; a type records only what
 * shape it HAS, and `Math.random() < 0.5 ? "h" : "t"` and `config.mode` are the
 * SAME TYPE. So this rejects a widened `string` and nothing subtler:
 *
 * - `` `charge-${coin}` `` where `coin` is `"h" | "t"` infers a UNION OF
 *   LITERALS, which is not `string`, so it passes. That is the measured bug — 7
 *   of 10 runs executing a side effect twice, see
 *   `aai-runtime/workflow-replay-divergence.ts` — and it is caught at RUNTIME
 *   instead.
 * - `` `charge-${Date.now()}` `` is `` `charge-${number}` ``, also not `string`,
 *   also passes. `guard-invariants` rule 30 is the layer that sees that one, by
 *   banning the clock in a shipped body rather than by typing the name.
 *
 * An `IsUnion` rejection would catch the first case and was deliberately NOT
 * added: it false-positives on a name derived from a legitimate config union,
 * and a gate that refuses correct code is worse than the runtime check catching
 * the mistake. Three layers, none a substitute for another.
 *
 * @internal
 */
export type Literal<S extends string> = string extends S ? never : S;
