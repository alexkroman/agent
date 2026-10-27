// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  FailedCallMemo,
  MAX_REMEMBERED_FAILURES,
  REPEATED_FAILURE_REASON,
} from "./failed-call-memo.ts";

const NOT_FOUND = "Error: User not found";

describe("FailedCallMemo", () => {
  test("a call that never failed runs", () => {
    const memo = new FailedCallMemo();
    expect(memo.refuse("find_user", { name: "Ada" }, 1)).toBeUndefined();
  });

  test("an identical failed call is refused, quoting the failure — key order does not matter", () => {
    const memo = new FailedCallMemo();
    memo.settle("find_user", { first: "Sophia", zip: "78260" }, NOT_FOUND, 1);
    const refusal = memo.refuse("find_user", { zip: "78260", first: "Sophia" }, 2);
    expect(refusal).toBeDefined();
    const parsed = JSON.parse(refusal as string) as { error: string; reason: string };
    expect(parsed.reason).toBe(REPEATED_FAILURE_REASON);
    expect(parsed.error).toContain("find_user already failed");
    expect(parsed.error).toContain(NOT_FOUND);
  });

  test("changing any argument, or the tool, is a new call", () => {
    const memo = new FailedCallMemo();
    memo.settle("find_user", { first: "Sophia", zip: "78260" }, NOT_FOUND, 1);
    expect(memo.refuse("find_user", { first: "Sofia", zip: "78260" }, 2)).toBeUndefined();
    expect(memo.refuse("find_user_by_email", { first: "Sophia", zip: "78260" }, 2)).toBeUndefined();
  });

  test("a failure is answered with every failed call so far, in order", () => {
    const memo = new FailedCallMemo();
    expect(memo.settle("find_user", { first: "Sophia" }, NOT_FOUND, 1)).toBe(
      'Already tried, all failed: find_user({"first":"Sophia"})',
    );
    expect(memo.settle("find_user", { first: "Sofia" }, '{"error":"nope"}', 2)).toBe(
      'Already tried, all failed: find_user({"first":"Sophia"}); find_user({"first":"Sofia"})',
    );
  });

  test("a success says nothing and forgets every failure — the world may have changed", () => {
    const memo = new FailedCallMemo();
    memo.settle("get_order", { id: "W1" }, "Error: Order not found", 1);
    expect(memo.settle("find_user", { first: "Sofia" }, "sofia_li_7352", 2)).toBeUndefined();
    expect(memo.refuse("get_order", { id: "W1" }, 3)).toBeUndefined();
  });

  test("a history that shrank is a new conversation, and the memory is dropped", () => {
    const memo = new FailedCallMemo();
    memo.settle("find_user", { first: "Sophia" }, NOT_FOUND, 12);
    expect(memo.refuse("find_user", { first: "Sophia" }, 14)).toBeDefined();
    // A reset empties the history; the next call sees a short one.
    expect(memo.refuse("find_user", { first: "Sophia" }, 1)).toBeUndefined();
  });

  test("remembers only the most recent failures", () => {
    const memo = new FailedCallMemo();
    for (let i = 0; i <= MAX_REMEMBERED_FAILURES; i++) {
      memo.settle("find_user", { n: i }, NOT_FOUND, 1);
    }
    expect(memo.refuse("find_user", { n: 0 }, 1)).toBeUndefined();
    expect(memo.refuse("find_user", { n: MAX_REMEMBERED_FAILURES }, 1)).toBeDefined();
  });
});
