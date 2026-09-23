// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, expectTypeOf, test } from "vitest";
import { SESSION_EVENT_TYPES, SessionEventSchema } from "./protocol-events.ts";
import {
  SESSION_SOURCED_EVENT_TYPES,
  type SessionEvent,
  type SessionEventBody,
  type SessionEventMap,
  type SessionEventType,
} from "./session-event-map.ts";

describe("SessionEventMap", () => {
  test("is keyed by exactly the schema's event names", () => {
    const fromSchema = SessionEventSchema.options.map((o) => o.shape.type.value).sort();
    expect([...SESSION_EVENT_TYPES].sort()).toEqual(fromSchema);
    expectTypeOf<SessionEventType>().toEqualTypeOf<
      (typeof SessionEventSchema.options)[number]["shape"]["type"]["value"]
    >();
  });

  test("a lookup is the member, and a bare SessionEvent the whole union", () => {
    expectTypeOf<SessionEvent<"tool.called">>().toEqualTypeOf<SessionEventMap["tool.called"]>();
    expectTypeOf<SessionEvent<"tool.called">["toolName"]>().toEqualTypeOf<string>();
    expectTypeOf<SessionEvent>().toEqualTypeOf<SessionEventMap[SessionEventType]>();
  });

  test("a body distributes, keeping each member's own type and dropping meta", () => {
    expectTypeOf<SessionEventBody<"reply.completed" | "speech.started">>().toEqualTypeOf<
      { type: "reply.completed" } | { type: "speech.started" }
    >();
    expectTypeOf<SessionEventBody>().not.toHaveProperty("meta");
  });
});

describe("SESSION_SOURCED_EVENT_TYPES", () => {
  test("names only real events, each once", () => {
    for (const type of SESSION_SOURCED_EVENT_TYPES)
      expect(SESSION_EVENT_TYPES.has(type)).toBe(true);
    expect(new Set(SESSION_SOURCED_EVENT_TYPES).size).toBe(SESSION_SOURCED_EVENT_TYPES.length);
  });
});
