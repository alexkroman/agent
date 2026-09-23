// Copyright 2026 the AAI authors. MIT license.
// Specs for the tool-pair guard. The first case is the production failure in
// miniature: a step that ended on an unsafe finish reason, persisted as an
// assistant tool call with nothing answering it.

import type { ModelMessage, ToolModelMessage } from "ai";
import { describe, expect, test, vi } from "vitest";
import {
  pairToolCalls,
  pairToolCallsInPlace,
  pairToolCallsLogged,
  UNEXECUTED_TOOL_CALL_ERROR,
} from "./tool-call-pairs.ts";

const user = (content: string): ModelMessage => ({ role: "user", content });

const call = (...ids: string[]): ModelMessage => ({
  role: "assistant",
  content: ids.map((id) => ({ type: "tool-call", toolCallId: id, toolName: `t_${id}`, input: {} })),
});

const result = (...ids: string[]): ToolModelMessage => ({
  role: "tool",
  content: ids.map((id) => ({
    type: "tool-result",
    toolCallId: id,
    toolName: `t_${id}`,
    output: { type: "text", value: `r_${id}` },
  })),
});

const synthetic = (...ids: string[]): ToolModelMessage => ({
  role: "tool",
  content: ids.map((id) => ({
    type: "tool-result",
    toolCallId: id,
    toolName: `t_${id}`,
    output: { type: "error-json", value: { error: UNEXECUTED_TOOL_CALL_ERROR } },
  })),
});

describe("pairToolCalls", () => {
  test("an unanswered call gets a synthetic error result right after its message", () => {
    const history = [user("hi"), call("c1"), user("hello?")];
    const paired = pairToolCalls(history);
    expect(paired.messages).toEqual([user("hi"), call("c1"), synthetic("c1"), user("hello?")]);
    expect(paired.repairs).toEqual([{ kind: "orphan-call", toolCallId: "c1", toolName: "t_c1" }]);
  });

  test("an unanswered call at the END of the history is repaired too", () => {
    expect(pairToolCalls([user("hi"), call("c1")]).messages).toEqual([
      user("hi"),
      call("c1"),
      synthetic("c1"),
    ]);
  });

  test("a partly answered step keeps its real results and appends the missing one after them", () => {
    const history: ModelMessage[] = [
      user("hi"),
      call("c1", "c2"),
      result("c1"),
      { role: "assistant", content: "ok" },
    ];
    expect(pairToolCalls(history).messages).toEqual([
      user("hi"),
      call("c1", "c2"),
      result("c1"),
      synthetic("c2"),
      { role: "assistant", content: "ok" },
    ]);
  });

  test("a result with no call ahead of it is dropped, and an emptied tool message goes too", () => {
    const history = [user("hi"), result("ghost"), call("c1"), result("c1", "ghost2")];
    const paired = pairToolCalls(history);
    expect(paired.messages).toEqual([user("hi"), call("c1"), result("c1")]);
    expect(paired.repairs).toEqual([
      { kind: "orphan-result", toolCallId: "ghost", toolName: "t_ghost" },
      { kind: "orphan-result", toolCallId: "ghost2", toolName: "t_ghost2" },
    ]);
  });

  test("a result cannot answer a call across a user message — the SDK's own window", () => {
    // The SDK checks at every user/system message that each call since has
    // been answered, so a result on the far side of one answers nothing.
    const history = [user("a"), call("c1"), user("b"), result("c1")];
    expect(pairToolCalls(history).messages).toEqual([
      user("a"),
      call("c1"),
      synthetic("c1"),
      user("b"),
    ]);
  });

  test("a well-formed history comes back as the SAME array, untouched", () => {
    const history: ModelMessage[] = [
      user("hi"),
      call("c1"),
      result("c1"),
      { role: "assistant", content: "done" },
      user("next"),
      // A result later in the window still answers — not adjacency, the SDK's rule.
      call("c2"),
      { role: "assistant", content: "hm" },
      result("c2"),
    ];
    const paired = pairToolCalls(history);
    expect(paired.messages).toBe(history);
    expect(paired.repairs).toEqual([]);
  });

  test("a provider-executed call needs no result", () => {
    const history: ModelMessage[] = [
      user("hi"),
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "p1",
            toolName: "web",
            input: {},
            providerExecuted: true,
          },
        ],
      },
    ];
    expect(pairToolCalls(history).messages).toBe(history);
  });

  test("is idempotent", () => {
    const once = pairToolCalls([user("hi"), result("ghost"), call("c1", "c2"), result("c2")]);
    const twice = pairToolCalls(once.messages);
    expect(twice.repairs).toEqual([]);
    expect(twice.messages).toBe(once.messages);
  });
});

describe("pairToolCallsLogged / pairToolCallsInPlace", () => {
  test("logs each repair once, naming the session, the call and the tool", () => {
    const log = { warn: vi.fn() };
    pairToolCallsLogged([user("hi"), call("c1"), result("ghost")], log, "sid-1");
    expect(log.warn.mock.calls).toEqual([
      ["Orphaned tool call repaired", { sid: "sid-1", toolCallId: "c1", toolName: "t_c1" }],
      ["Orphaned tool result dropped", { sid: "sid-1", toolCallId: "ghost", toolName: "t_ghost" }],
    ]);
  });

  test("rewrites an owned array in place, and leaves a paired one alone", () => {
    const broken = [user("hi"), call("c1")];
    pairToolCallsInPlace(broken, undefined, undefined);
    expect(broken).toEqual([user("hi"), call("c1"), synthetic("c1")]);

    const log = { warn: vi.fn() };
    const fine = [user("hi"), call("c1"), result("c1")];
    const before = [...fine];
    pairToolCallsInPlace(fine, log, "s");
    expect(fine).toEqual(before);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
