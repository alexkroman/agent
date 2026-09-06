// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  dialogResultSchema,
  expectDialogOk,
  expectDialogRefused,
  expectToolOk,
} from "./testing.ts";
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

describe("expectDialogRefused", () => {
  const refusal = toolFailure(
    'Not available yet: this conversation is at "identifying". Verify the caller first.',
  );

  test("hands back the refusal, so the spec can read the instruction off it", () => {
    expect(expectDialogRefused(refusal)).toBe(refusal);
    expect(expectDialogRefused(refusal, "identifying").error).toMatch(/Verify the caller/);
  });

  test("throws when the gate did NOT hold, naming where the dialog landed", () => {
    // The hand-rolled shape — `expect(isToolFailure(x)).toBe(true)` followed by
    // assertions inside `if (isToolFailure(x))` — passed a SUCCESS through with
    // every assertion after the guard skipped.
    expect(() => expectDialogRefused(answered)).toThrow(
      /Expected the dialog to refuse this call and it answered an object .* — the dialog is at "quote.pending"/,
    );
    expect(() => expectDialogRefused({ quoted: 42 })).toThrow(
      /it answered an object with keys: quoted\./,
    );
  });

  test("throws on a refusal at some OTHER state, quoting it", () => {
    expect(() => expectDialogRefused(refusal, "transferred")).toThrow(
      'Expected a dialog refusal at "transferred" and got: Not available yet',
    );
  });

  test("a failure that is not the gate's sentence is not a dialog refusal", () => {
    expect(() => expectDialogRefused(toolFailure("Order not found."))).toThrow(
      "Expected a dialog refusal and got: Order not found.",
    );
  });
});

describe("dialogResultSchema", () => {
  const Quote = dialogResultSchema(z.object({ quoted: z.number() }));

  test("parses the envelope a `dialog.tool` writes, the author's result inside it", () => {
    expect(Quote.parse(answered)).toEqual(answered);
  });

  test("the instruction is optional, since a state declares one or does not", () => {
    const { instruction: _omitted, ...bare } = answered;
    expect(Quote.parse(bare)).toEqual(bare);
  });

  test("names the envelope field that stopped matching", () => {
    // The whole reason to parse rather than cast: a template that stopped
    // carrying its position fails HERE, on `state`, not two assertions later on
    // a property of `undefined`.
    const noPosition = Quote.safeParse({ result: { quoted: 42 }, done: false });
    expect(noPosition.success).toBe(false);
    expect(noPosition.error?.issues.map((issue) => issue.path)).toEqual([["state"]]);
  });

  test("checks the author's own result through the schema it was handed", () => {
    const wrongShape = Quote.safeParse({ ...answered, result: { quoted: "forty-two" } });
    expect(wrongShape.success).toBe(false);
    expect(wrongShape.error?.issues.map((issue) => issue.path)).toEqual([["result", "quoted"]]);
  });

  test("a refusal is not an envelope, so it does not parse as one", () => {
    expect(Quote.safeParse(toolFailure("Verify the caller first.")).success).toBe(false);
  });
});
