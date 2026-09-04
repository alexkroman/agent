// Copyright 2026 the AAI authors. MIT license.
/**
 * The tool half of the vocabulary, driven over CALL RECORDS rather than events.
 *
 * `toolAssertions` takes the calls a scope already derived, so a spec here
 * needs no event list and no stamping helper — which is also the seam that lets
 * a never-completed call (`result: undefined`) be expressed at all, and that is
 * the state every hand-rolled version of these claims rendered as a green one.
 * `assertions.test.ts` covers the same arms through a real scope, over a real
 * TEXT agent's events.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import type { EvalToolCall } from "@alexkroman1/aai-runtime/eval";
import { describe, expect, test } from "vitest";
import { createRecorder } from "./runner.ts";
import { countVerdict, toolAssertions } from "./tool-assertions.ts";

/** A completed call. `result` absent means the tool never came back. */
function call(name: string, result?: string): EvalToolCall {
  return { toolCallId: `c${name}${result ?? ""}`, name, args: {}, ...omitUndefined({ result }) };
}

function arms(calls: readonly EvalToolCall[]) {
  const rec = createRecorder();
  return {
    ...toolAssertions(rec.check, calls),
    failed: () => rec.checks.filter((c) => !c.ok),
    held: () => rec.checks.filter((c) => c.ok),
    checks: rec.checks,
  };
}

const TS_ERROR = /error TS\d/;

describe("countVerdict", () => {
  test("absent bounds mean AT LEAST ONE, so a claim about nothing fails", () => {
    expect(countVerdict(0, {})).toEqual({ ok: false, bound: "" });
    expect(countVerdict(1, {})).toEqual({ ok: true, bound: "" });
  });

  test("an exact count wins over min/max and names itself", () => {
    expect(countVerdict(2, { count: 2, min: 9 })).toEqual({ ok: true, bound: " =2" });
    expect(countVerdict(3, { count: 2 }).ok).toBe(false);
  });

  test("min and max are inclusive and both reach the label", () => {
    expect(countVerdict(2, { min: 1, max: 3 })).toEqual({ ok: true, bound: " >=1 <=3" });
    expect(countVerdict(4, { min: 1, max: 3 }).ok).toBe(false);
    // `{ max: 0 }` is how a caller says NEVER without a second method — and
    // the reason the bound is rendered even when it is a zero.
    expect(countVerdict(0, { max: 0 })).toEqual({ ok: true, bound: " <=0" });
    expect(countVerdict(1, { max: 0 }).ok).toBe(false);
  });
});

describe("toolResultMatching", () => {
  test("finds a diagnostic in any tool's result and names the pattern", () => {
    const t = arms([
      call("write_file", "src/a.ts(3,1): error TS2345: nope"),
      call("test_agent", "ok"),
    ]);
    t.toolResultMatching(TS_ERROR);
    expect(t.held().map((c) => c.label)).toEqual(["toolResultMatching(/error TS\\d/)"]);
  });

  test("a string pattern matches case-insensitively", () => {
    const t = arms([call("test_agent", "Tests: FAILED")]);
    t.toolResultMatching("tests: failed");
    expect(t.failed()).toEqual([]);
  });

  test("`tools` narrows which results count, and says so in the label", () => {
    const calls = [call("read_file", "error TS2345 in the file I read"), call("write_file", "ok")];
    const t = arms(calls);
    // The diagnostic is in a READ, which is not a verification — the whole
    // point of the filter, since a repair count that counts reads is not one.
    t.toolResultMatching(TS_ERROR, { tools: ["write_file", "check_types"] });
    expect(t.failed().map((c) => c.label)).toEqual([
      "toolResultMatching(/error TS\\d/ in write_file|check_types)",
    ]);
  });

  test("bounds make it a repair count, and the detail carries the tally", () => {
    const t = arms([
      call("write_file", "error TS2345"),
      call("write_file", "error TS2345"),
      call("write_file", "ok"),
    ]);
    t.toolResultMatching(TS_ERROR, { tools: ["write_file"], max: 1 });
    const failure = t.failed()[0];
    expect(failure?.label).toBe("toolResultMatching(/error TS\\d/ in write_file) <=1");
    expect(failure?.detail).toContain("2 of 3 result(s) matched");
  });

  test("a call that NEVER COMPLETED matches nothing and is named as such", () => {
    // The state a hand-rolled `(c.result ?? "")` walk renders identically to a
    // green result: no diagnostic, because there is no result.
    const t = arms([call("check_types")]);
    t.toolResultMatching(TS_ERROR);
    expect(t.failed()[0]?.detail).toContain("check_types (never completed)");
  });
});

describe("noToolResultMatching", () => {
  test("holds over clean results and reports how many it read", () => {
    const t = arms([call("check_types", "no errors"), call("test_agent", "Tests: PASSED")]);
    t.noToolResultMatching(TS_ERROR);
    expect(t.held()[0]?.detail).toBeUndefined();
    expect(t.checks[0]?.ok).toBe(true);
  });

  test("fails carrying the offending output itself, not just a tally", () => {
    const t = arms([call("check_types", "src/a.ts(3,1): error TS2345: nope")]);
    t.noToolResultMatching(TS_ERROR);
    const failure = t.failed()[0];
    expect(failure?.label).toBe("noToolResultMatching(/error TS\\d/)");
    // A reader can act on this; "1 of 1 matched" alone is not a finding.
    expect(failure?.detail).toContain("first from check_types");
    expect(failure?.detail).toContain("error TS2345: nope");
  });

  test("truncates a long diagnostic rather than printing a whole build log", () => {
    const t = arms([call("test_agent", `${"x".repeat(500)} error TS1005`)]);
    t.noToolResultMatching(TS_ERROR);
    expect(t.failed()[0]?.detail).toContain("…");
    expect((t.failed()[0]?.detail ?? "").length).toBeLessThan(320);
  });
});

describe("eachToolFollowedBy", () => {
  test("holds when EVERY call to the first has a later call to the second", () => {
    const t = arms([
      call("write_file", "ok"),
      call("check_types", "clean"),
      call("write_file", "ok"),
      call("test_agent", "PASSED"),
      call("check_types", "clean"),
    ]);
    t.eachToolFollowedBy("write_file", "check_types");
    expect(t.failed()).toEqual([]);
  });

  test("fails on the LAST unchecked write, where toolOrder would have held", () => {
    const calls = [
      call("write_file", "ok"),
      call("check_types", "clean"),
      call("write_file", "ok"),
    ];
    const t = arms(calls);
    t.eachToolFollowedBy("write_file", "check_types");
    const failure = t.failed()[0];
    expect(failure?.label).toBe("eachToolFollowedBy(write_file → check_types)");
    expect(failure?.detail).toContain("1 of 2 write_file call(s) had no later check_types");
    expect(failure?.detail).toContain("write_file → check_types → write_file");
  });

  test("fails when the first tool was never called at all", () => {
    // Vacuously true is the wrong answer: an agent that wrote no file is the
    // finding, which is this vocabulary's standing rule about absent scopes.
    const t = arms([call("read_file", "…")]);
    t.eachToolFollowedBy("write_file", "check_types");
    expect(t.failed()[0]?.detail).toContain("write_file was never called");
  });

  test("counts a repeated second call once per preceding first call", () => {
    const t = arms([call("check_types", "clean"), call("write_file", "ok")]);
    // The check came BEFORE the write, which is exactly the ordering
    // `toolOrder(["check_types", "write_file"])` would report as fine and this
    // must not.
    t.eachToolFollowedBy("write_file", "check_types");
    expect(t.failed()).toHaveLength(1);
  });
});
