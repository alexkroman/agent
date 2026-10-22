// Copyright 2026 the AAI authors. MIT license.
// The one grammar every session event name follows: `<subject>.<verb>`, each
// segment camelCase — `tool.called`, `userTranscript.committed`,
// `session.timedOut`. The vocabulary once mixed hyphenated compounds
// (`userTurn.exceeded`) with plain nouns (`tool.called`), so an author could
// not predict a name from the one beside it; this pins the grammar at the
// schema, the single source every other name is derived from.
import { describe, expect, test } from "vitest";
import { SESSION_EVENT_TYPES } from "./protocol-events.ts";
import type { SessionEventMap } from "./session-event-map.ts";

const EVENT_NAME = /^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$/;

describe("session event names", () => {
  test("the vocabulary is not empty", () => {
    expect(SESSION_EVENT_TYPES.size).toBeGreaterThan(0);
  });

  test.each([...SESSION_EVENT_TYPES])("%s is <subject>.<verb> in camelCase", (name) => {
    expect(name).toMatch(EVENT_NAME);
  });

  // The hand-declared map and the schema name the same events: none missing
  // from either side.
  test("SessionEventMap names exactly the schema's events", () => {
    const declared: Record<keyof SessionEventMap, true> = {
      "session.configured": true,
      "audio.completed": true,
      "speech.started": true,
      "speech.stopped": true,
      "userTranscript.updated": true,
      "userTranscript.committed": true,
      "agentTranscript.updated": true,
      "agentTranscript.committed": true,
      "tool.called": true,
      "tool.completed": true,
      "reply.completed": true,
      "reply.cancelled": true,
      "session.reset": true,
      "session.timedOut": true,
      "error.reported": true,
      "custom.emitted": true,
      "state.updated": true,
      "usage.updated": true,
      "guardrail.blocked": true,
      "userTurn.exceeded": true,
      "provider.failedOver": true,
      "metrics.collected": true,
      "history.restored": true,
    };
    expect(new Set(Object.keys(declared))).toEqual(SESSION_EVENT_TYPES);
  });
});
