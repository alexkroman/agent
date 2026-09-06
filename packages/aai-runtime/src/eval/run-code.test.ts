// Copyright 2026 the AAI authors. MIT license.
/**
 * The `run_code` readers, over hand-built calls.
 *
 * The one property worth more than the rest: a REFUSAL throws, and the throw
 * is keyed on the constant the executor writes rather than on a regex a case
 * re-typed. The "reworded refusal" test is the A/B for that — it is the state
 * the four template copies would have passed.
 */

import { RUN_CODE_REFUSAL } from "@alexkroman1/aai/host-internal";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { describe, expect, test } from "vitest";
import type { EvalToolCall } from "./events.ts";
import { isRunCodeRefusal, runCodeIn, runCodeOutput } from "./run-code.ts";

const call = (
  name: string,
  args: Record<string, unknown>,
  result?: string,
  id = `c-${name}`,
): EvalToolCall => ({ toolCallId: id, name, args, ...omitUndefined({ result }) });

/** What the tool executor puts on the wire for the builtin's refusal. */
const REFUSED = JSON.stringify({ error: RUN_CODE_REFUSAL });

describe("runCodeIn", () => {
  test("joins the code every run_code call carried, in call order, skipping other tools", () => {
    expect(
      runCodeIn([
        call("run_code", { code: "console.log(1)" }, "1", "a"),
        call("fetch_json", { url: "https://x" }, "{}"),
        call("run_code", { code: "console.log(2)" }, "2", "b"),
      ]),
    ).toBe("console.log(1)\nconsole.log(2)");
  });

  test("no run_code call answers the empty string — 'never reached for code' is a claim", () => {
    expect(runCodeIn([call("fetch_json", { url: "https://x" }, "{}")])).toBe("");
  });

  test("a code argument the model renamed FAILS naming the field, never reads as ''", () => {
    // The `String(c.args.code ?? "")` this replaced answered `""` here, and a
    // case asserting `toContain("90")` then failed on an empty string with no
    // word about why.
    expect(() => runCodeIn([call("run_code", { source: "console.log(1)" }, "1")])).toThrow(
      /"run_code" call 0's args does not match the schema.*code/s,
    );
  });
});

describe("runCodeOutput", () => {
  test("answers what the code printed, verbatim, joined across calls", () => {
    expect(
      runCodeOutput([
        call("run_code", { code: "…" }, "Saturday", "a"),
        call("run_code", { code: "…" }, "3.106855", "b"),
      ]),
    ).toBe("Saturday\n3.106855");
  });

  test("a snippet that threw reads as its own error envelope, not [object Object]", () => {
    expect(
      runCodeOutput([call("run_code", { code: "nope()" }, '{"error":"nope is not defined"}')]),
    ).toBe('{"error":"nope is not defined"}');
  });

  test("the REFUSAL throws naming the fix, rather than answering the sentence as output", () => {
    // The claim the whole module exists for: with no executor every output
    // assertion would otherwise hold against this string.
    expect(() => runCodeOutput([call("run_code", { code: "1+1" }, REFUSED)])).toThrow(
      /REFUSED rather than ran.*createVmRunCode/s,
    );
  });

  test("a call that never completed throws naming its position", () => {
    expect(() =>
      runCodeOutput([call("run_code", { code: "1" }, "1", "a"), call("run_code", { code: "2" })]),
    ).toThrow(/the 2nd call to "run_code" never completed/);
  });

  test("no run_code call answers the empty string", () => {
    expect(runCodeOutput([])).toBe("");
  });
});

describe("isRunCodeRefusal", () => {
  test("is keyed on the executor's own constant, so a reworded refusal still counts", () => {
    // A/B against the regex the templates typed: `/only available in the
    // sandboxed runtime/` would say `false` here, and a case would read the
    // refusal as output.
    const reworded = REFUSED.replace("only available in the sandboxed runtime", "SANDBOX-ONLY");
    expect(isRunCodeRefusal(REFUSED)).toBe(true);
    expect(isRunCodeRefusal(reworded)).toBe(false);
    // …which is exactly why the constant is imported rather than matched: the
    // two are the same string by construction, not by regex.
    expect(REFUSED).toContain(RUN_CODE_REFUSAL);
  });

  test("a code error the snippet raised is a RESULT, not a refusal", () => {
    expect(isRunCodeRefusal('{"error":"nope is not defined"}')).toBe(false);
    expect(isRunCodeRefusal("107823")).toBe(false);
  });
});
