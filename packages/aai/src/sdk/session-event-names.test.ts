// Copyright 2026 the AAI authors. MIT license.
// The one grammar every session event name follows: `<subject>.<verb>`, each
// segment camelCase — `tool.called`, `userTranscript.committed`,
// `session.timedOut`. The vocabulary once mixed hyphenated compounds
// (`userTurn.exceeded`) with plain nouns (`tool.called`), so an author could
// not predict a name from the one beside it; this pins the grammar at the
// schema, the single source every other name is derived from.
import { describe, expect, expectTypeOf, test } from "vitest";
import { SESSION_EVENT_TYPES } from "./protocol-events.ts";
import type { SessionEventType, SessionEventTypeList } from "./session-event-map.ts";

const EVENT_NAME = /^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$/;

describe("session event names", () => {
  test("the vocabulary is not empty", () => {
    expect(SESSION_EVENT_TYPES.size).toBeGreaterThan(0);
  });

  test.each([...SESSION_EVENT_TYPES])("%s is <subject>.<verb> in camelCase", (name) => {
    expect(name).toMatch(EVENT_NAME);
  });

  // The spelled-out list is what the `aai:events` contract hash reads the names
  // from, so it must be exactly the schema's set: no name missing, none extra.
  test("SessionEventTypeList is exactly the schema's names", () => {
    expectTypeOf<SessionEventTypeList[number]>().toEqualTypeOf<SessionEventType>();
    // Same length as the schema's set, so the list repeats no name.
    expectTypeOf<SessionEventTypeList["length"]>().toEqualTypeOf<23>();
    expect(SESSION_EVENT_TYPES.size).toBe(23);
  });
});
