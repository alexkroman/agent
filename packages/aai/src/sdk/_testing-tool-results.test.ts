// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { expectDialogOk, expectToolOk } from "./testing.ts";
import { toolFailure } from "./utils.ts";

/** What a `dialog()` tool answers on success: the value, wrapped in the position. */
const answered = {
  result: { quoted: 42 },
  state: "quote.pending",
  done: false,
  instruction: "Read the quote back.",
};

describe("expectToolOk", () => {
  test("hands back the tool's own value from inside the envelope", () => {
    expect(expectToolOk<{ quoted: number }>(answered)).toEqual({ quoted: 42 });
  });

  test("throws NAMING the refusal, which is the whole reason it exists", () => {
    // The cast it replaces reads `.result` off the failure, gets `undefined`,
    // and fails several assertions later on a property of undefined — with the
    // sentence the dialog wrote about what has to happen first thrown away.
    expect(() => expectToolOk(toolFailure("Verify the caller first."))).toThrow(
      "tool refused: Verify the caller first.",
    );
  });

  test("says so when handed something that is not an envelope at all", () => {
    // A plain `tool()` answers with its own value; there is nothing to unwrap,
    // and `undefined` would be the silent alternative.
    expect(() => expectToolOk({ quoted: 42 })).toThrow(/Expected a dialog tool result/);
  });

  test("a null or a primitive is reported by what it IS", () => {
    expect(() => expectToolOk(null)).toThrow(/and got null/);
    expect(() => expectToolOk("done")).toThrow(/and got string/);
    expect(() => expectToolOk([1, 2])).toThrow(/and got an array/);
  });

  test("a `result` of undefined is still a result", () => {
    // A gated tool whose execute returns nothing still lands somewhere, and the
    // envelope is what the model reads. `"result" in value` is the test, not
    // truthiness.
    expect(expectToolOk({ result: undefined, state: "done", done: true })).toBeUndefined();
  });
});

describe("expectDialogOk", () => {
  test("keeps where the dialog landed", () => {
    expect(expectDialogOk<{ quoted: number }>(answered)).toEqual({
      result: { quoted: 42 },
      state: "quote.pending",
      done: false,
      instruction: "Read the quote back.",
    });
  });

  test("omits the instruction rather than carrying an undefined one", () => {
    // `DialogPosition.instruction` is optional, and a state that declares none
    // must not read as one that declared `undefined`.
    expect(expectDialogOk({ result: 1, state: "start", done: false })).toEqual({
      result: 1,
      state: "start",
      done: false,
    });
  });

  test("refuses the same things `expectToolOk` refuses, since `expectToolOk` is this plus `.result`", () => {
    expect(() => expectDialogOk(toolFailure("No."))).toThrow("tool refused: No.");
    expect(() => expectDialogOk({ state: "start", done: true })).toThrow(
      /Expected a dialog tool result/,
    );
  });
});
