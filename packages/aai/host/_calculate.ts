// Copyright 2026 the AAI authors. MIT license.
/**
 * Safe arithmetic evaluator backing the `calculate` builtin tool.
 *
 * Built on expr-eval-fork's `Parser`, locked down to pure arithmetic —
 * expressions are never handed to `eval`/`Function`. Precedence and
 * associativity follow the common calculator convention: `-2 ^ 2` is
 * `-(2 ^ 2) = -4` and `2 ^ 3 ^ 2` is `2 ^ (3 ^ 2) = 512`.
 *
 * The input is model-controlled and this runs in the host process, so the
 * parser is configured restrictively (see {@link parser}) and every
 * expression is evaluated against a frozen empty scope. A charset guard
 * additionally rejects any identifier characters up front (only `e`/`E`
 * pass, for scientific notation), so named functions, constants, and
 * variables are unreachable twice over.
 */

import { Parser } from "expr-eval-fork";
import { errorMessage } from "../sdk/utils.ts";

/** Longest expression accepted — bounds tokenizer work and parse recursion. */
const MAX_EXPRESSION_LENGTH = 500;

/**
 * Significant digits kept in results. Trims binary float noise
 * (`0.1 + 0.2` → `0.3`, not `0.30000000000000004`) while staying far more
 * precise than any spoken dollar amount needs.
 */
const RESULT_PRECISION = 12;

export type CalculateResult = { ok: true; value: number } | { ok: false; error: string };

/**
 * The complement of the characters the arithmetic grammar can ever need
 * (digits, decimal point, the operators, parentheses, and `e`/`E` for
 * scientific notation) — so the first match IS the offending character and one
 * pass both rejects and names it. Anything else (letters, `;`, `!`, `[`, …)
 * never reaches the parser.
 *
 * `u` so an astral character is reported whole rather than as half a surrogate
 * pair, which is what iterating the string with `[...cleaned]` used to buy.
 */
const DISALLOWED_CHAR = /[^0-9.eE+\-*/%^()]/u;

/**
 * Arithmetic-only parser: `+ - * / %` (remainder) and `^` (power) stay on;
 * assignment, member access, function definitions, comparisons, logical /
 * conditional / concatenation operators, factorial, `in`, and every named
 * function are all disabled.
 */
const parser = new Parser({
  allowMemberAccess: false,
  operators: {
    add: true,
    subtract: true,
    multiply: true,
    divide: true,
    remainder: true,
    power: true,
    assignment: false,
    fndef: false,
    comparison: false,
    concatenate: false,
    conditional: false,
    logical: false,
    factorial: false,
    in: false,
    random: false,
    min: false,
    max: false,
    sin: false,
    cos: false,
    tan: false,
    asin: false,
    acos: false,
    atan: false,
    sinh: false,
    cosh: false,
    tanh: false,
    asinh: false,
    acosh: false,
    atanh: false,
    sqrt: false,
    log: false,
    ln: false,
    lg: false,
    log10: false,
    abs: false,
    ceil: false,
    floor: false,
    round: false,
    trunc: false,
    exp: false,
    length: false,
    cbrt: false,
    expm1: false,
    log1p: false,
    sign: false,
    log2: false,
  },
});
// `E`/`PI` are built-in constants; wipe them (and the function table) so any
// identifier that slips past the charset guard fails as an undefined
// variable instead of evaluating.
parser.consts = {};
parser.functions = {};

/** Expressions must not read or write any scope — frozen and empty. */
const EMPTY_SCOPE: Readonly<Record<string, never>> = Object.freeze({});

/**
 * Evaluate an arithmetic expression without `eval`.
 *
 * Supports `+ - * / %` (remainder), `^` (power, right-associative),
 * parentheses, unary minus/plus, and decimal/scientific number literals.
 * Currency symbols, commas, and whitespace are ignored.
 */
export function calculate(expression: string): CalculateResult {
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    return { ok: false, error: `Expression exceeds ${MAX_EXPRESSION_LENGTH} characters` };
  }
  // LLMs routinely format amounts as "$1,234.50" — strip currency symbols and
  // thousands separators (there are no function calls, so a comma is never
  // meaningful) rather than failing the whole call over formatting.
  const cleaned = expression.replace(/[$,\s]/g, "");
  if (cleaned.length === 0) return { ok: false, error: "Empty expression" };
  const offending = DISALLOWED_CHAR.exec(cleaned);
  if (offending) {
    return {
      ok: false,
      error: `Unexpected character "${offending[0]}" — only numbers, + - * / % ^ and parentheses are supported`,
    };
  }
  try {
    const value: unknown = parser.parse(cleaned).evaluate(EMPTY_SCOPE);
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ok: false, error: "Result is not a finite number (division by zero?)" };
    }
    return { ok: true, value: Number(value.toPrecision(RESULT_PRECISION)) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
