// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, expectTypeOf, test } from "vitest";
import type { SessionEventBody } from "./session-event-map.ts";
import { eventsOf, isEvent } from "./testing-events.ts";

const recorded: SessionEventBody[] = [
  { type: "speech.started" },
  { type: "tool.called", toolCallId: "c1", toolName: "lookup", args: {} },
  { type: "tool.completed", toolCallId: "c1", result: "{}" },
  { type: "tool.called", toolCallId: "c2", toolName: "book", args: { at: 1 } },
];

describe("eventsOf", () => {
  test("keeps only the named events, in order, typed as that member", () => {
    const calls = eventsOf(recorded, "tool.called");
    expect(calls.map((e) => e.toolName)).toEqual(["lookup", "book"]);
    expectTypeOf(calls).toEqualTypeOf<SessionEventBody<"tool.called">[]>();
  });

  test("takes any iterable and answers [] when nothing matches", () => {
    expect(eventsOf(new Set(recorded), "reply.completed")).toEqual([]);
  });

  test("a name outside the recording's union does not compile", () => {
    // @ts-expect-error — not a session event
    expect(eventsOf(recorded, "tool.caled")).toEqual([]);
  });
});

describe("isEvent", () => {
  test("narrows the event it guards", () => {
    const event = recorded[2];
    if (event === undefined) throw new Error("fixture");
    expect(isEvent(event, "tool.completed")).toBe(true);
    expect(isEvent(event, "tool.called")).toBe(false);
    if (isEvent(event, "tool.completed")) expectTypeOf(event.result).toEqualTypeOf<string>();
  });
});
