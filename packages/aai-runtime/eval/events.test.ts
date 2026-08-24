// Copyright 2026 the AAI authors. MIT license.

import type { SessionEvent } from "@alexkroman1/aai/protocol";
import { describe, expect, test } from "vitest";
import { saidIn, TURN_ENDS, toolCallsIn } from "./events.ts";

/** Every event carries one; nothing here reads it, so one value serves all. */
const meta = { id: "e1", at: 0 };

const called = (id: string, name: string, args: Record<string, unknown>): SessionEvent => ({
  type: "tool.called",
  meta,
  toolCallId: id,
  toolName: name,
  args,
});
const completed = (id: string, result: string): SessionEvent => ({
  type: "tool.completed",
  meta,
  toolCallId: id,
  result,
});
const saidByAgent = (text: string): SessionEvent => ({
  type: "agent-transcript.committed",
  meta,
  text,
});

describe("saidIn", () => {
  test("reads committed replies in order and ignores everything else", () => {
    expect(
      saidIn([
        saidByAgent("Hi there."),
        { type: "agent-transcript.updated", meta, text: "It sh" },
        saidByAgent("It shipped."),
      ]),
    ).toEqual(["Hi there.", "It shipped."]);
  });

  test("is empty for a run that said nothing", () => {
    expect(saidIn([])).toEqual([]);
  });
});

describe("toolCallsIn", () => {
  test("pairs each call with the result that answered it", () => {
    expect(
      toolCallsIn([
        called("c1", "look_up", { id: "W1" }),
        completed("c1", '"shipped"'),
        called("c2", "cancel", { id: "W1" }),
        completed("c2", '"done"'),
      ]),
    ).toEqual([
      { toolCallId: "c1", name: "look_up", args: { id: "W1" }, result: '"shipped"' },
      { toolCallId: "c2", name: "cancel", args: { id: "W1" }, result: '"done"' },
    ]);
  });

  test("reports a call that never completed rather than dropping it", () => {
    const calls = toolCallsIn([called("c1", "look_up", {})]);
    expect(calls).toHaveLength(1);
    // The key is ABSENT rather than undefined: "it called the tool and the tool
    // never returned" is a finding, and a `result` of undefined reads as one.
    expect(calls[0] && "result" in calls[0]).toBe(false);
  });
});

describe("TURN_ENDS", () => {
  test("is the two reply terminators, and nothing that merely looks like one", () => {
    expect([...TURN_ENDS].sort()).toEqual(["reply.cancelled", "reply.completed"]);
    expect(TURN_ENDS.has("agent-transcript.committed")).toBe(false);
  });
});
