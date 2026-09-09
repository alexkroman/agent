// Copyright 2026 the AAI authors. MIT license.
import { MAX_TOOL_RESULT_CHARS } from "@alexkroman1/aai/internal";
import { describe, expect, test, vi } from "vitest";
import { makeLogger } from "./_test-utils.ts";
import { stringifyResult, warnOversizedResult } from "./_tool-result-text.ts";

describe("stringifyResult", () => {
  // The provider is handed a string or nothing works, so every arm here is
  // about never returning `undefined` — which is what a bare JSON.stringify
  // answers for a function or a symbol.
  test("a string passes through untouched, so a tool's own prose is not re-quoted", () => {
    expect(stringifyResult("already text")).toBe("already text");
  });

  test("null and undefined both become the literal `null`", () => {
    expect(stringifyResult(null)).toBe("null");
    expect(stringifyResult(undefined)).toBe("null");
  });

  test("an object is JSON", () => {
    expect(stringifyResult({ id: "A1", total: 42 })).toBe('{"id":"A1","total":42}');
  });

  test("a function falls back to String() rather than answering undefined", () => {
    // `JSON.stringify(() => {})` is `undefined`, and handing that to the
    // provider is how a tool result becomes the four characters "undefined"
    // or nothing at all.
    const result = stringifyResult(() => "x");
    expect(typeof result).toBe("string");
    expect(result).not.toBe("undefined");
  });

  test("a symbol does the same", () => {
    expect(typeof stringifyResult(Symbol("s"))).toBe("string");
  });
});

describe("warnOversizedResult", () => {
  test("says nothing for a result within the cap", () => {
    const logger = makeLogger();
    warnOversizedResult("small", "x".repeat(MAX_TOOL_RESULT_CHARS), logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("warns once per tool, not once per call — the whole point of the latch", () => {
    const logger = makeLogger();
    const big = "x".repeat(MAX_TOOL_RESULT_CHARS + 1);
    const name = `chatty-${Math.random()}`;
    warnOversizedResult(name, big, logger);
    warnOversizedResult(name, big, logger);
    warnOversizedResult(name, big, logger);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  test("the message names the tool, the size and the cap, because the reader is fixing that tool", () => {
    const logger = makeLogger();
    const over = MAX_TOOL_RESULT_CHARS + 500;
    warnOversizedResult(`sized-${Math.random()}`, "x".repeat(over), logger);
    expect(logger.warn.mock.calls[0]?.[0]).toContain(String(over));
    expect(logger.warn.mock.calls[0]?.[0]).toContain(String(MAX_TOOL_RESULT_CHARS));
  });

  test("a second tool still gets its own first warning", () => {
    const logger = makeLogger();
    const big = "x".repeat(MAX_TOOL_RESULT_CHARS + 1);
    warnOversizedResult(`first-${Math.random()}`, big, logger);
    warnOversizedResult(`second-${Math.random()}`, big, logger);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  test("falls back to console.warn when no logger was supplied", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(vi.fn());
    warnOversizedResult(
      `nologger-${Math.random()}`,
      "x".repeat(MAX_TOOL_RESULT_CHARS + 1),
      undefined,
    );
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
