// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  FAILURE_STREAK_ESCALATION,
  FailedCallMemo,
  MAX_REMEMBERED_FAILURES,
  REPEATED_FAILURE_REASON,
} from "./failed-call-memo.ts";

const NOT_FOUND = "Error: User not found";

describe("FailedCallMemo", () => {
  test("a call that never failed runs", () => {
    const memo = new FailedCallMemo();
    expect(memo.refuse("find_user", { name: "Ada" })).toBeUndefined();
  });

  test("an identical failed call is refused, quoting the failure — key order does not matter", () => {
    const memo = new FailedCallMemo();
    memo.settle("find_user", { first: "Sophia", zip: "78260" }, NOT_FOUND);
    const refusal = memo.refuse("find_user", { zip: "78260", first: "Sophia" });
    expect(refusal).toBeDefined();
    const parsed = JSON.parse(refusal as string) as { error: string; reason: string };
    expect(parsed.reason).toBe(REPEATED_FAILURE_REASON);
    expect(parsed.error).toContain("find_user already failed");
    expect(parsed.error).toContain(NOT_FOUND);
  });

  test("changing any argument, or the tool, is a new call", () => {
    const memo = new FailedCallMemo();
    memo.settle("find_user", { first: "Sophia", zip: "78260" }, NOT_FOUND);
    expect(memo.refuse("find_user", { first: "Sofia", zip: "78260" })).toBeUndefined();
    expect(memo.refuse("find_user_by_email", { first: "Sophia", zip: "78260" })).toBeUndefined();
  });

  test("a failure is answered with every failed call so far, in order", () => {
    const memo = new FailedCallMemo();
    expect(memo.settle("find_user", { first: "Sophia" }, NOT_FOUND)).toBe(
      'Already tried, all failed: find_user({"first":"Sophia"})',
    );
    expect(memo.settle("find_user", { first: "Sofia" }, '{"error":"nope"}')).toBe(
      'Already tried, all failed: find_user({"first":"Sophia"}); find_user({"first":"Sofia"})',
    );
  });

  test("a success says nothing and forgets every failure — the world may have changed", () => {
    const memo = new FailedCallMemo();
    memo.settle("get_order", { id: "W1" }, "Error: Order not found");
    expect(memo.settle("find_user", { first: "Sofia" }, "sofia_li_7352")).toBeUndefined();
    expect(memo.refuse("get_order", { id: "W1" })).toBeUndefined();
  });

  test("a reset drops the memory", () => {
    const memo = new FailedCallMemo();
    memo.settle("find_user", { first: "Sophia" }, NOT_FOUND);
    expect(memo.refuse("find_user", { first: "Sophia" })).toBeDefined();
    memo.reset();
    expect(memo.refuse("find_user", { first: "Sophia" })).toBeUndefined();
  });

  test("remembers only the most recent failures", () => {
    const memo = new FailedCallMemo();
    for (let i = 0; i <= MAX_REMEMBERED_FAILURES; i++) {
      memo.settle("find_user", { n: i }, NOT_FOUND);
    }
    expect(memo.refuse("find_user", { n: 0 })).toBeUndefined();
    expect(memo.refuse("find_user", { n: MAX_REMEMBERED_FAILURES })).toBeDefined();
  });

  describe("escalation after a streak of failures on one tool", () => {
    const failN = (memo: FailedCallMemo, name: string, n: number, from = 0): string | undefined => {
      let note: string | undefined;
      for (let i = from; i < from + n; i++) note = memo.settle(name, { email: `v${i}` }, NOT_FOUND);
      return note;
    };

    test("the note escalates on the streak's threshold failure, not before", () => {
      const memo = new FailedCallMemo();
      expect(failN(memo, "find_user", FAILURE_STREAK_ESCALATION - 1)).not.toContain("stop varying");
      const note = failN(memo, "find_user", 1, FAILURE_STREAK_ESCALATION);
      expect(note).toContain("Already tried, all failed:");
      expect(note).toContain(`find_user has now failed ${FAILURE_STREAK_ESCALATION} times`);
      expect(note).toContain("different identifier");
    });

    test("the count keeps rising past the remembered-failure cap", () => {
      const memo = new FailedCallMemo();
      const note = failN(memo, "find_user", MAX_REMEMBERED_FAILURES + 2);
      expect(note).toContain(`has now failed ${MAX_REMEMBERED_FAILURES + 2} times`);
    });

    test("each tool counts its own failures", () => {
      const memo = new FailedCallMemo();
      failN(memo, "find_user_by_email", FAILURE_STREAK_ESCALATION);
      expect(failN(memo, "find_user_by_name", 1)).not.toContain("stop varying");
    });

    test("a success, or a reset, starts the streak over", () => {
      const memo = new FailedCallMemo();
      failN(memo, "find_user", FAILURE_STREAK_ESCALATION - 1);
      memo.settle("get_order", { id: "W1" }, '{"id":"W1"}');
      expect(failN(memo, "find_user", 1, 100)).not.toContain("stop varying");
      failN(memo, "find_user", FAILURE_STREAK_ESCALATION, 200);
      memo.reset();
      expect(failN(memo, "find_user", 1, 300)).not.toContain("stop varying");
    });
  });
});
