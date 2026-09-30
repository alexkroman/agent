// Copyright 2026 the AAI authors. MIT license.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { MAX_TOOL_RESULT_CHARS } from "./constants.ts";
import { fitToolResult } from "./fit-tool-result.ts";

const chars = (v: unknown) => JSON.stringify(v).length;

describe("fitToolResult", () => {
  test("drops nulls and empties even when the answer already fits", () => {
    expect(
      fitToolResult({ a: 1, b: null, c: "", d: [], e: {}, f: { g: null }, h: [null, 0, false] }),
    ).toEqual({ a: 1, h: [0, false] });
  });

  test("clips long strings to maxString, marked", () => {
    const out = fitToolResult({ body: "x".repeat(50) }, { maxString: 10 }) as { body: string };
    expect(out.body).toBe(`${"x".repeat(9)}…`);
  });

  test("shortens the longest list from the end and says how many it kept", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i, subject: `mail number ${i}` }));
    const out = fitToolResult(
      { total: 100, rows },
      { maxChars: 1500, hint: "Use the workbench." },
    ) as {
      result: { total: number; rows: { id: number }[] };
      note: string;
    };
    expect(chars(out)).toBeLessThanOrEqual(1500);
    expect(out.result.total).toBe(100);
    expect(out.result.rows[0]?.id).toBe(0);
    const kept = out.result.rows.length;
    expect(kept).toBeGreaterThan(1);
    expect(out.note).toBe(
      `Trimmed to fit: kept ${kept} of 100. Ask for fewer or narrower results. Use the workbench.`,
    );
  });

  test("falls back to the start of the text when there is no list to shorten", () => {
    const out = fitToolResult({ page: "y".repeat(5000) }, { maxChars: 500 }) as {
      result_start: string;
      note: string;
    };
    expect(chars(out)).toBeLessThanOrEqual(500);
    expect(out.result_start.startsWith('{"page":"yyy')).toBe(true);
    expect(out.note).toMatch(/only the start/);
  });

  test("defaults to the runtime's own cap, and never mutates its input", () => {
    const input = { rows: Array.from({ length: 2000 }, (_, i) => ({ i, pad: "z".repeat(20) })) };
    const before = JSON.stringify(input);
    expect(chars(fitToolResult(input))).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    expect(JSON.stringify(input)).toBe(before);
  });

  test("property: whatever the value, the answer fits", () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.integer({ min: 200, max: 3000 }), (value, maxChars) => {
        expect(chars(fitToolResult(value, { maxChars }) ?? null)).toBeLessThanOrEqual(maxChars);
      }),
      { numRuns: 200 },
    );
  });
});
