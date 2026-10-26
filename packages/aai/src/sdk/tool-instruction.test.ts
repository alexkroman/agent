// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  INSTRUCTION_KEY,
  instructionOf,
  stripInstruction,
  withInstruction,
} from "./tool-instruction.ts";
import { isToolFailure, toolFailure } from "./utils.ts";

describe("withInstruction", () => {
  test("rides on the result under the reserved key, leaving the value's own fields alone", () => {
    const result = withInstruction({ steps: ["a", "b"] }, "Read the plan back in one breath.");
    expect(result).toEqual({
      steps: ["a", "b"],
      [INSTRUCTION_KEY]: "Read the plan back in one breath.",
    });
    expect(INSTRUCTION_KEY).toBe("$instruction");
  });

  test("returns a NEW object, so a shared value is not rewritten under the author", () => {
    const value = { count: 1 };
    const result = withInstruction(value, "Name the count.");
    expect(result).not.toBe(value);
    expect(value).toEqual({ count: 1 });
  });

  test("a failure may carry one and is still a failure to the guard", () => {
    const refused = withInstruction(toolFailure("No such order."), "Ask for the number again.");
    expect(isToolFailure(refused)).toBe(true);
    expect(instructionOf(refused)).toBe("Ask for the number again.");
  });

  test("refuses a blank instruction, naming the remedy", () => {
    expect(() => withInstruction({ ok: true }, "   ")).toThrow(/blank instruction/);
  });
});

describe("instructionOf", () => {
  test("reads the key off a result, and the same off its JSON round trip", () => {
    const result = withInstruction({ ok: true }, "Say so.");
    expect(instructionOf(result)).toBe("Say so.");
    expect(instructionOf(JSON.parse(JSON.stringify(result)))).toBe("Say so.");
  });

  test("answers undefined for a result without one, a non-record, or a non-string key", () => {
    expect(instructionOf({ ok: true })).toBeUndefined();
    expect(instructionOf("text")).toBeUndefined();
    expect(instructionOf(null)).toBeUndefined();
    expect(instructionOf({ [INSTRUCTION_KEY]: 3 })).toBeUndefined();
  });
});

describe("stripInstruction", () => {
  test("drops the key and nothing else, on a copy", () => {
    const result = withInstruction({ steps: ["a"], total: 1 }, "Count them.");
    const stripped = stripInstruction(result);
    expect(stripped).toEqual({ steps: ["a"], total: 1 });
    expect(instructionOf(result)).toBe("Count them.");
  });

  test("passes a result carrying none through as it was, by identity", () => {
    const plain = { ok: true };
    expect(stripInstruction(plain)).toBe(plain);
    expect(stripInstruction("text")).toBe("text");
    expect(stripInstruction(undefined)).toBeUndefined();
  });
});
