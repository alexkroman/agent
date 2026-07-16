// Copyright 2026 the AAI authors. MIT license.
/**
 * Safe arithmetic evaluator backing the `calculate` builtin tool.
 *
 * A hand-rolled tokenizer + recursive-descent parser over a fixed grammar —
 * expressions are never handed to `eval`/`Function`. Precedence and
 * associativity follow the common calculator convention (cf. expr-eval):
 *
 *   expr    := term (("+" | "-") term)*
 *   term    := unary (("*" | "/" | "%") unary)*
 *   unary   := ("-" | "+") unary | power
 *   power   := primary ("^" unary)?          // right-associative
 *   primary := NUMBER | "(" expr ")"
 *
 * So `-2 ^ 2` is `-(2 ^ 2) = -4` and `2 ^ 3 ^ 2` is `2 ^ (3 ^ 2) = 512`.
 */

/** Longest expression accepted — bounds tokenizer work and parse recursion. */
const MAX_EXPRESSION_LENGTH = 500;

/**
 * Significant digits kept in results. Trims binary float noise
 * (`0.1 + 0.2` → `0.3`, not `0.30000000000000004`) while staying far more
 * precise than any spoken dollar amount needs.
 */
const RESULT_PRECISION = 12;

export type CalculateResult = { ok: true; value: number } | { ok: false; error: string };

type Token = { kind: "number"; value: number } | { kind: "op"; op: string };

const OPERATOR_CHARS = new Set(["+", "-", "*", "/", "%", "^", "(", ")"]);
const NUMBER_START = /[0-9.]/;
const NUMBER_BODY = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/;

function tokenize(expression: string): Token[] | string {
  // LLMs routinely format amounts as "$1,234.50" — strip currency symbols and
  // thousands separators (there are no function calls, so a comma is never
  // meaningful) rather than failing the whole call over formatting.
  const cleaned = expression.replace(/[$,\s]/g, "");
  const tokens: Token[] = [];
  let i = 0;
  while (i < cleaned.length) {
    const ch = cleaned[i] as string;
    if (OPERATOR_CHARS.has(ch)) {
      tokens.push({ kind: "op", op: ch });
      i += 1;
      continue;
    }
    if (NUMBER_START.test(ch)) {
      const match = NUMBER_BODY.exec(cleaned.slice(i));
      if (!match) return `Malformed number at position ${i}`;
      tokens.push({ kind: "number", value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    return `Unexpected character "${ch}" — only numbers, + - * / % ^ and parentheses are supported`;
  }
  return tokens;
}

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
  const tokens = tokenize(expression);
  if (typeof tokens === "string") return { ok: false, error: tokens };
  if (tokens.length === 0) return { ok: false, error: "Empty expression" };

  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const nextOp = (): string | undefined => {
    const t = tokens[pos];
    return t?.kind === "op" ? t.op : undefined;
  };

  function parseExpr(): number {
    let left = parseTerm();
    for (let op = nextOp(); op === "+" || op === "-"; op = nextOp()) {
      pos += 1;
      const right = parseTerm();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  function parseTerm(): number {
    let left = parseUnary();
    for (let op = nextOp(); op === "*" || op === "/" || op === "%"; op = nextOp()) {
      pos += 1;
      const right = parseUnary();
      if (op === "*") left *= right;
      else if (op === "/") left /= right;
      else left %= right;
    }
    return left;
  }

  function parseUnary(): number {
    const op = nextOp();
    if (op === "-" || op === "+") {
      pos += 1;
      const value = parseUnary();
      return op === "-" ? -value : value;
    }
    return parsePower();
  }

  function parsePower(): number {
    const base = parsePrimary();
    if (nextOp() === "^") {
      pos += 1;
      return base ** parseUnary();
    }
    return base;
  }

  function parsePrimary(): number {
    const token = peek();
    if (token === undefined) throw new Error("Unexpected end of expression");
    if (token.kind === "number") {
      pos += 1;
      return token.value;
    }
    if (token.op === "(") {
      pos += 1;
      const value = parseExpr();
      if (nextOp() !== ")") throw new Error("Missing closing parenthesis");
      pos += 1;
      return value;
    }
    throw new Error(`Unexpected "${token.op}" in expression`);
  }

  try {
    const value = parseExpr();
    if (pos < tokens.length) {
      const trailing = tokens[pos];
      const shown = trailing?.kind === "op" ? trailing.op : String(trailing?.value);
      return { ok: false, error: `Unexpected "${shown}" after end of expression` };
    }
    if (!Number.isFinite(value)) {
      return { ok: false, error: "Result is not a finite number (division by zero?)" };
    }
    return { ok: true, value: Number(value.toPrecision(RESULT_PRECISION)) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
