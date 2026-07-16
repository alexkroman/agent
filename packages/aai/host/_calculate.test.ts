// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { calculate } from "./_calculate.ts";

function value(expression: string): number {
  const result = calculate(expression);
  if (!result.ok) throw new Error(`Expected ok for "${expression}", got: ${result.error}`);
  return result.value;
}

function error(expression: string): string {
  const result = calculate(expression);
  if (result.ok) throw new Error(`Expected error for "${expression}", got: ${result.value}`);
  return result.error;
}

describe("calculate", () => {
  test("basic arithmetic and precedence", () => {
    expect(value("1 + 2 * 3")).toBe(7);
    expect(value("(1 + 2) * 3")).toBe(9);
    expect(value("10 - 4 - 3")).toBe(3); // left-associative
    expect(value("100 / 5 / 2")).toBe(10);
    expect(value("7 % 3")).toBe(1);
  });

  test("float noise is trimmed from results", () => {
    expect(value("0.1 + 0.2")).toBe(0.3);
    expect(value("154.99 * 3")).toBe(464.97);
  });

  test("exponentiation is right-associative and binds tighter than unary minus", () => {
    expect(value("2 ^ 3 ^ 2")).toBe(512);
    expect(value("-2 ^ 2")).toBe(-4);
    expect(value("(-2) ^ 2")).toBe(4);
  });

  test("unary operators", () => {
    expect(value("-5 + 10")).toBe(5);
    expect(value("--5")).toBe(5);
    expect(value("+3")).toBe(3);
    expect(value("2 * -3")).toBe(-6);
  });

  test("currency symbols, commas, and whitespace are ignored", () => {
    expect(value("$1,234.50 + $765.50")).toBe(2000);
    expect(value("  2   +\t2 ")).toBe(4);
  });

  test("scientific notation and leading-dot decimals", () => {
    expect(value("1.5e3 + 500")).toBe(2000);
    expect(value(".5 * 4")).toBe(2);
  });

  test("realistic customer-service math", () => {
    // change fee + fare difference, with 7.25% tax
    expect(value("(75 + 120.40) * 1.0725")).toBe(209.5665);
    // split refund across 3 passengers
    expect(value("463.47 / 3")).toBe(154.49);
  });

  test("division by zero returns an error, not Infinity", () => {
    expect(error("1 / 0")).toMatch(/finite/);
  });

  test("malformed input returns errors instead of throwing", () => {
    expect(error("")).toBe("Empty expression");
    expect(error("2 +")).toMatch(/Unexpected end/);
    expect(error("(1 + 2")).toMatch(/closing parenthesis/);
    expect(error("1 + 2)")).toMatch(/after end of expression/);
    expect(error("two + 2")).toMatch(/Unexpected character/);
    expect(error("1 // 2")).toMatch(/Unexpected/);
  });

  test("no code execution — JS syntax is rejected", () => {
    expect(calculate("process.exit(1)").ok).toBe(false);
    expect(calculate("1; console.log(2)").ok).toBe(false);
    expect(calculate("constructor").ok).toBe(false);
  });

  test("over-long expressions are rejected", () => {
    expect(error(`1${"+1".repeat(400)}`)).toMatch(/exceeds 500 characters/);
  });
});
