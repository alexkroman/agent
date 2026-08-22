// Copyright 2026 the AAI authors. MIT license.

import { DEFAULT_MAX_HISTORY } from "@alexkroman1/aai";
import type { SessionEvent, SessionEventBody } from "@alexkroman1/aai/protocol";
import { describe, expect, test } from "vitest";
import { messagesFromEvents } from "./session-event-history.ts";
import { stampSessionEvent } from "./session-event-stream.ts";

/** Stamp a body, the way the log holds it. */
const at = (body: SessionEventBody): SessionEvent => stampSessionEvent(body);

const user = (text: string) => at({ type: "user-transcript.committed", text });
const agent = (text: string) => at({ type: "agent-transcript.committed", text });

describe("messagesFromEvents", () => {
  test("reads the conversation back in order", () => {
    expect(messagesFromEvents([user("hi"), agent("hello"), user("bye")])).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "bye" },
    ]);
  });

  test("an empty log is an empty conversation", () => {
    expect(messagesFromEvents([])).toEqual([]);
  });

  test("interim transcripts are NOT turns", () => {
    // Interim snapshots legitimately shrink and differ mid-string, and an
    // interrupted reply's last one is not a record of anything — so reading them
    // would invent turns the session never committed.
    const events = [
      at({ type: "user-transcript.updated", text: "h" }),
      user("hi"),
      at({ type: "agent-transcript.updated", text: "hel" }),
      agent("hello"),
    ];
    expect(messagesFromEvents(events)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  test("an interrupted reply contributes no assistant turn", () => {
    // `onAgentTranscript(text, interrupted: true)` emits only the UPDATED event,
    // which is exactly the live session's own history rule — see the module doc
    // for why under-keeping is the cheap direction.
    const events = [user("stop"), at({ type: "agent-transcript.updated", text: "I was say" })];
    expect(messagesFromEvents(events)).toEqual([{ role: "user", content: "stop" }]);
  });

  test("everything else in the log is ignored", () => {
    const events = [
      at({ type: "session.configured", audioFormat: "pcm16", sampleRate: 1, ttsSampleRate: 1 }),
      at({ type: "speech.started" }),
      user("hi"),
      at({ type: "tool.called", toolCallId: "c1", toolName: "look", args: {} }),
      at({ type: "tool.completed", toolCallId: "c1", result: "{}" }),
      at({ type: "state.updated", state: {} }),
      at({ type: "reply.completed" }),
    ];
    expect(messagesFromEvents(events)).toEqual([{ role: "user", content: "hi" }]);
  });

  test("a reset DISCARDS everything before it", () => {
    const events = [user("old"), agent("older"), at({ type: "session.reset" }), user("new")];
    // Replaying across a reset would restore turns the caller explicitly cleared,
    // and the agent would then answer as though they had not.
    expect(messagesFromEvents(events)).toEqual([{ role: "user", content: "new" }]);
  });

  test("the window is trimmed at the FRONT, like the live session's", () => {
    const events = Array.from({ length: DEFAULT_MAX_HISTORY + 5 }, (_, i) => user(`m${i}`));

    const messages = messagesFromEvents(events);

    expect(messages).toHaveLength(DEFAULT_MAX_HISTORY);
    // A resumed session must not come back holding more context than it could
    // have accumulated without dropping.
    expect(messages[0]).toEqual({ role: "user", content: "m5" });
  });
});
