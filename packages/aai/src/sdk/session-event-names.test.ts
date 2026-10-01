// Copyright 2026 the AAI authors. MIT license.
// The one grammar every session event name follows: `<subject>.<verb>`, each
// segment camelCase — `tool.called`, `userTranscript.committed`,
// `session.timedOut`. The vocabulary once mixed hyphenated compounds
// (`user-turn.exceeded`) with plain nouns (`tool.called`), so an author could
// not predict a name from the one beside it; this pins the grammar at the
// schema, the single source every other name is derived from.
import { describe, expect, test } from "vitest";
import { SESSION_EVENT_TYPES } from "./protocol-events.ts";

const EVENT_NAME = /^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$/;

describe("session event names", () => {
  test("the vocabulary is not empty", () => {
    expect(SESSION_EVENT_TYPES.size).toBeGreaterThan(0);
  });

  test.each([...SESSION_EVENT_TYPES])("%s is <subject>.<verb> in camelCase", (name) => {
    expect(name).toMatch(EVENT_NAME);
  });
});
