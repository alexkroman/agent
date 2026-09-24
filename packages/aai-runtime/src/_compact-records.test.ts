// Copyright 2026 the AAI authors. MIT license.
import { serializeToolFailure } from "@alexkroman1/aai/host-internal";
import { MAX_TOOL_RESULT_CHARS } from "@alexkroman1/aai/internal";
import { describe, expect, test } from "vitest";
import { compactRecordsForModel } from "./_compact-records.ts";
import { stringifyResult } from "./_tool-result-text.ts";

/** A tool's return value as the executor hands it on. */
const asText = (value: unknown): string => stringifyResult(value);

const variant = (id: string, color: string, size: string, available: boolean, price: number) => ({
  id,
  options: { color, size },
  available,
  price,
});

describe("compactRecordsForModel", () => {
  test("an id-keyed map of same-shaped records becomes one row per record", () => {
    const result = {
      "0012": variant("0012", "red", "S", false, 9.5),
      "0345": variant("0345", "blue", "M", true, 12),
      "9001x": variant("9001x", "red", "L", true, 10.25),
    };
    expect(compactRecordsForModel(asText(result))).toBe(
      [
        "3 records (key column: id): id | options.color | options.size | available | price",
        "0012 | red | S | false | 9.5",
        "0345 | blue | M | true | 12",
        "9001x | red | L | true | 10.25",
      ].join("\n"),
    );
  });

  test("a map keyed by something the records do not carry gets a leading key column", () => {
    const result = {
      a: { color: "red", price: 1 },
      b: { color: "blue", price: 2 },
      c: { color: "green", price: 3 },
    };
    expect(compactRecordsForModel(asText(result))).toBe(
      [
        "3 records (key column: key): key | color | price",
        "a | red | 1",
        "b | blue | 2",
        "c | green | 3",
      ].join("\n"),
    );
  });

  test("an array of same-shaped records becomes rows with an index column, in order", () => {
    const result = [
      { color: "red", available: true },
      { color: "blue", available: false },
      { color: "green", available: null },
    ];
    expect(compactRecordsForModel(asText(result))).toBe(
      [
        "3 records (key column: index): index | color | available",
        "0 | red | true",
        "1 | blue | false",
        "2 | green | null",
      ].join("\n"),
    );
  });

  test("a nested collection is spliced into the surrounding JSON on its own lines", () => {
    const result = {
      name: "Widget",
      id: "77",
      variants: {
        "1": variant("1", "red", "S", true, 5),
        "2": variant("2", "red", "M", false, 6),
        "3": variant("3", "red", "L", true, 7),
      },
      tags: ["x", "y"],
    };
    expect(compactRecordsForModel(asText(result))).toBe(
      [
        '{"name":"Widget","id":"77","variants":',
        "3 records (key column: id): id | options.color | options.size | available | price",
        "1 | red | S | true | 5",
        "2 | red | M | false | 6",
        "3 | red | L | true | 7",
        ',"tags":["x","y"]}',
      ].join("\n"),
    );
  });

  test("deeper nested scalar objects flatten to dotted keys", () => {
    const rec = (n: number) => ({ id: `r${n}`, a: { b: { c: n } } });
    expect(compactRecordsForModel(asText([rec(1), rec(2), rec(3)]))).toBe(
      [
        "3 records (key column: index): index | id | a.b.c",
        "0 | r1 | 1",
        "1 | r2 | 2",
        "2 | r3 | 3",
      ].join("\n"),
    );
  });

  test("records whose key sets differ are left as they were", () => {
    const text = asText([
      { id: "1", color: "red" },
      { id: "2", color: "blue" },
      { id: "3", size: "L" },
    ]);
    expect(compactRecordsForModel(text)).toBe(text);
  });

  test("a nested object whose keys differ between records counts as a different key set", () => {
    const text = asText([
      variant("1", "red", "S", true, 1),
      variant("2", "red", "S", true, 1),
      { id: "3", options: { color: "red", material: "wool" }, available: true, price: 1 },
    ]);
    expect(compactRecordsForModel(text)).toBe(text);
  });

  test("fewer than three records are left as they were", () => {
    const text = asText({ a: { color: "red" }, b: { color: "blue" } });
    expect(compactRecordsForModel(text)).toBe(text);
  });

  test("a record holding an array or an empty object is not a row", () => {
    const withArray = asText([
      { id: "1", tags: ["a"] },
      { id: "2", tags: ["b"] },
      { id: "3", tags: ["c"] },
    ]);
    expect(compactRecordsForModel(withArray)).toBe(withArray);
    const withEmpty = asText([
      { id: "1", extra: {} },
      { id: "2", extra: {} },
      { id: "3", extra: {} },
    ]);
    expect(compactRecordsForModel(withEmpty)).toBe(withEmpty);
  });

  test("an array of scalars, or a mix of records and scalars, is not a collection", () => {
    const scalars = asText({ ids: ["1", "2", "3", "4"] });
    expect(compactRecordsForModel(scalars)).toBe(scalars);
    const mixed = asText([{ id: "1" }, { id: "2" }, "3"]);
    expect(compactRecordsForModel(mixed)).toBe(mixed);
  });

  test("a JSON string from a relayed tool is handled, and its original bytes kept when nothing qualifies", () => {
    // A relayed result is whatever text the client sent — here with spaces
    // after separators, which a re-serialization would drop.
    const spaced = '{"id": "1", "items": [{"a": 1}, {"b": 2}]}';
    expect(compactRecordsForModel(spaced)).toBe(spaced);
    const relayed = '[{"id": "1", "ok": true}, {"id": "2", "ok": false}, {"id": "3", "ok": true}]';
    expect(compactRecordsForModel(relayed)).toBe(
      [
        "3 records (key column: index): index | id | ok",
        "0 | 1 | true",
        "1 | 2 | false",
        "2 | 3 | true",
      ].join("\n"),
    );
  });

  test("text that is not a JSON object or array is returned untouched", () => {
    for (const text of ["plain words", "", "42", '"quoted"', "{not json", "null", "[1, 2"]) {
      expect(compactRecordsForModel(text)).toBe(text);
    }
  });

  test("values stay verbatim: leading zeros, numeric-looking strings, booleans, decimals", () => {
    const result = [
      { id: "000123", code: "1e3", flag: true, n: 0.1 },
      { id: "0", code: "true", flag: false, n: -3 },
      { id: "007", code: "", flag: true, n: 1_000_000 },
    ];
    expect(compactRecordsForModel(asText(result))).toBe(
      [
        "3 records (key column: index): index | id | code | flag | n",
        "0 | 000123 | 1e3 | true | 0.1",
        "1 | 0 | true | false | -3",
        "2 | 007 |  | true | 1000000",
      ].join("\n"),
    );
  });

  test("the delimiter, backslashes and line breaks inside a value are escaped", () => {
    const result = [
      { id: "1", note: "a | b" },
      { id: "2", note: "back\\slash" },
      { id: "3", note: "two\nlines\r" },
    ];
    expect(compactRecordsForModel(asText(result))).toBe(
      [
        "3 records (key column: index): index | id | note",
        "0 | 1 | a \\| b",
        "1 | 2 | back\\\\slash",
        "2 | 3 | two\\nlines\\r",
      ].join("\n"),
    );
  });

  test("a tool failure is never reshaped", () => {
    const failure = serializeToolFailure("lookup failed");
    expect(compactRecordsForModel(failure)).toBe(failure);
  });

  test("a result over MAX_TOOL_RESULT_CHARS is left as it was", () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({ id: String(i), color: "red" }));
    const text = asText(rows);
    expect(text.length).toBeGreaterThan(MAX_TOOL_RESULT_CHARS);
    expect(compactRecordsForModel(text)).toBe(text);
  });

  test("numbers keep their source digits, even where a double could not", () => {
    const text = '[{"id":12345678901234567890,"n":1.10},{"id":1,"n":2E3},{"id":2,"n":-0}]';
    expect(compactRecordsForModel(text)).toBe(
      [
        "3 records (key column: index): index | id | n",
        "0 | 12345678901234567890 | 1.10",
        "1 | 1 | 2E3",
        "2 | 2 | -0",
      ].join("\n"),
    );
  });

  test("a relayed map keeps the order the tool wrote, digit-string keys included", () => {
    // `JSON.parse` would hoist "9001" (an integer-like key) above "0012".
    const text =
      '{"9001": {"id": "9001", "ok": true}, "0012": {"id": "0012", "ok": false}, "5": {"id": "5", "ok": true}}';
    expect(compactRecordsForModel(text)).toBe(
      ["3 records (key column: id): id | ok", "9001 | true", "0012 | false", "5 | true"].join("\n"),
    );
  });

  test("the JSON around a table keeps its source tokens", () => {
    const text =
      '{"big": 12345678901234567890, "s": "caf\\u00e9", "rows": [{"a": 1}, {"a": 2}, {"a": 3}]}';
    expect(compactRecordsForModel(text)).toBe(
      [
        '{"big":12345678901234567890,"s":"caf\\u00e9","rows":',
        "3 records (key column: index): index | a",
        "0 | 1",
        "1 | 2",
        "2 | 3",
        "}",
      ].join("\n"),
    );
  });
});
