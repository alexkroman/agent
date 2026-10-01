// Copyright 2026 the AAI authors. MIT license.

import type { SessionEvent, SessionEventBody } from "@alexkroman1/aai";
import { DEFAULT_MAX_HISTORY } from "@alexkroman1/aai/internal";
import { describe, expect, test } from "vitest";
import {
  historyFromEvents,
  MAX_SEEDED_TOOL_CALL_ID_CHARS,
  messagesFromEvents,
  modelHistoryOf,
  SEEDED_TOOL_ARG_VALUE_CHARS,
  SEEDED_TOOL_ARGS_CHARS,
  SEEDED_TOOL_RESULT_CHARS,
} from "./session-event-history.ts";
import { stampSessionEvent } from "./session-event-stream.ts";

/** Stamp a body, the way the log holds it. */
const at = (body: SessionEventBody): SessionEvent => stampSessionEvent(body);

const user = (text: string) => at({ type: "userTranscript.committed", text });
const agent = (text: string) => at({ type: "agentTranscript.committed", text });
/** The two phrases the TRANSPORT speaks itself when the model cannot. */
const recovery = (text: string, recovery: "turn-failed" | "session-failed") =>
  at({ type: "agentTranscript.committed", text, recovery });

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
      at({ type: "userTranscript.updated", text: "h" }),
      user("hi"),
      at({ type: "agentTranscript.updated", text: "hel" }),
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
    const events = [user("stop"), at({ type: "agentTranscript.updated", text: "I was say" })];
    expect(messagesFromEvents(events)).toEqual([{ role: "user", content: "stop" }]);
  });

  test("everything but a transcript and a settled tool call is ignored", () => {
    const events = [
      at({ type: "session.configured", audioFormat: "pcm16", sampleRate: 1, ttsSampleRate: 1 }),
      at({ type: "speech.started" }),
      user("hi"),
      at({ type: "tool.called", toolCallId: "c1", toolName: "look", args: {} }),
      at({ type: "tool.completed", toolCallId: "c1", result: "{}" }),
      at({ type: "state.updated", state: {} }),
      at({ type: "reply.completed" }),
    ];
    expect(messagesFromEvents(events)).toEqual([
      { role: "user", content: "hi" },
      { role: "tool", content: "{}", toolName: "look", toolCallId: "c1" },
    ]);
  });

  test("a reset DISCARDS everything before it", () => {
    const events = [user("old"), agent("older"), at({ type: "session.reset" }), user("new")];
    // Replaying across a reset would restore turns the caller explicitly cleared,
    // and the agent would then answer as though they had not.
    expect(messagesFromEvents(events)).toEqual([{ role: "user", content: "new" }]);
  });

  test("a RECOVERY phrase is not a turn", () => {
    // The defect this field exists for. `errorPhrase` and `startFailurePhrase`
    // are committed transcripts — deliberately, so the caption matches what the
    // caller heard — and both are kept out of the LIVE record for a measured
    // reason (`pipeline-turn-outcome.ts`: teaching the model that its own replies
    // open with apologies is how it starts producing them unprompted). Reading
    // them here put them back on the first reconnect, via `seedHistory`, and
    // every reconnect re-seeded.
    const events = [
      user("hi"),
      recovery("Sorry, I had a problem just then.", "turn-failed"),
      user("try again"),
      agent("hello"),
      recovery("I cannot start this call.", "session-failed"),
    ];
    expect(messagesFromEvents(events)).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: "try again" },
      { role: "assistant", content: "hello" },
    ]);
  });

  test("a say spoken with record: false is captioned but never part of the conversation", () => {
    // Live, on resume and in `ctx.messages` alike: this is the one reader.
    const unrecorded = at({
      type: "agentTranscript.committed",
      text: "One moment while I check.",
      recorded: false,
    });
    expect(messagesFromEvents([user("hi"), unrecorded, agent("Found it.")])).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Found it." },
    ]);
  });

  test("an UNTAGGED phrase is an ordinary reply, which is what an old log holds", () => {
    // The old-reader/old-log direction: an event written before the field
    // existed carries no `recovery`, so it reads as the reply it is
    // indistinguishable from — today's behaviour, never worse.
    expect(messagesFromEvents([agent("Sorry, I had a problem just then.")])).toEqual([
      { role: "assistant", content: "Sorry, I had a problem just then." },
    ]);
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

describe("historyFromEvents", () => {
  test("a RECOVERY phrase is not a turn here either, and the anchors follow", () => {
    // The client's restored transcript and the model's context come out of ONE
    // walk, so the tool-call anchors are indices into these messages: a phrase
    // skipped by one and kept by the other would slide every anchor by one.
    const events = [
      user("hi"),
      recovery("Sorry, I had a problem just then.", "turn-failed"),
      at({ type: "tool.called", toolCallId: "c1", toolName: "look", args: {} }),
      agent("hello"),
    ];

    const { messages, toolCalls } = historyFromEvents(events);

    expect(messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(toolCalls[0]?.afterMessageIndex).toBe(0);
  });

  test("a settled call contributes a tool message and the anchors SKIP it", () => {
    // The anchor indexes the messages the CLIENT receives — `restoreHistory`
    // filters the tool arm off before `history.restored` goes on the wire — so
    // counting the result would slide every later row down by one.
    const events = [
      user("where is order 4471"),
      at({ type: "tool.called", toolCallId: "c1", toolName: "lookup_order", args: { id: "4471" } }),
      at({ type: "tool.completed", toolCallId: "c1", result: '{"eta":"tue"}' }),
      agent("Tuesday."),
      user("and the other one"),
      at({ type: "tool.called", toolCallId: "c2", toolName: "lookup_order", args: { id: "9" } }),
    ];

    const { messages, toolCalls } = historyFromEvents(events);

    expect(messages).toEqual([
      { role: "user", content: "where is order 4471" },
      { role: "tool", content: '{"eta":"tue"}', toolName: "lookup_order", toolCallId: "c1" },
      { role: "assistant", content: "Tuesday." },
      { role: "user", content: "and the other one" },
    ]);
    // Three VISIBLE messages precede the second call, so its anchor is 2 —
    // where `messages` puts that turn at index 3, one further along for the
    // tool result the client never receives.
    expect(toolCalls.map((c) => c.afterMessageIndex)).toEqual([0, 2]);
  });

  test("a PENDING call contributes no message", () => {
    // It may genuinely have been in flight when the process died; there is no
    // result to report and inventing one is the failure this avoids.
    const events = [
      user("hi"),
      at({ type: "tool.called", toolCallId: "c1", toolName: "look", args: {} }),
    ];

    const { messages, toolCalls } = historyFromEvents(events);

    expect(messages).toEqual([{ role: "user", content: "hi" }]);
    expect(toolCalls[0]?.status).toBe("pending");
  });

  test("a completion whose call the front trim ate keeps the RESULT and drops the name", () => {
    // `Message.toolName` is optional precisely so this case has an answer that
    // is not a guess — the result is the half a tool reads.
    const events = [at({ type: "tool.completed", toolCallId: "c1", result: "42" })];

    expect(historyFromEvents(events).messages).toEqual([
      { role: "tool", content: "42", toolCallId: "c1" },
    ]);
  });

  test("a reset discards tool messages with the turns", () => {
    const events = [
      user("old"),
      at({ type: "tool.called", toolCallId: "c1", toolName: "look", args: {} }),
      at({ type: "tool.completed", toolCallId: "c1", result: "{}" }),
      at({ type: "session.reset" }),
      user("new"),
    ];

    expect(historyFromEvents(events)).toEqual({
      messages: [{ role: "user", content: "new" }],
      toolCalls: [],
    });
  });

  test("the front trim moves the anchors by the VISIBLE messages it dropped", () => {
    // A raw count would over-shift by the number of tool results that came off
    // with them, which reads as every tool row sliding toward the top.
    const events: SessionEvent[] = [];
    for (let i = 0; i < DEFAULT_MAX_HISTORY; i++) {
      events.push(user(`m${i}`));
      events.push(at({ type: "tool.completed", toolCallId: `t${i}`, result: "{}" }));
    }
    events.push(at({ type: "tool.called", toolCallId: "last", toolName: "look", args: {} }));

    const { messages, toolCalls } = historyFromEvents(events);

    expect(messages).toHaveLength(DEFAULT_MAX_HISTORY);
    const visible = messages.filter((m) => m.role !== "tool").length;
    // The last call followed every visible message that survived the trim.
    expect(toolCalls.at(-1)?.afterMessageIndex).toBe(visible - 1);
  });
});

describe("modelHistoryOf — prior tool calls as REAL call/result pairs", () => {
  const events = (bodies: SessionEventBody[]): SessionEvent[] =>
    bodies.map((b) => stampSessionEvent(b));
  const modelView = (bodies: SessionEventBody[]) => {
    const { messages, toolCalls } = historyFromEvents(events(bodies));
    return modelHistoryOf(messages, toolCalls);
  };

  test("a call is seeded as a tool-call part and a result under the same id, then the reply", () => {
    expect(
      modelView([
        { type: "userTranscript.committed", text: "weather in Portland?" },
        {
          type: "tool.called",
          toolCallId: "c1",
          toolName: "weather",
          args: { city: "Portland" },
        },
        { type: "tool.completed", toolCallId: "c1", result: '{"temp":12}' },
        { type: "agentTranscript.committed", text: "Twelve degrees." },
      ]),
    ).toEqual([
      { role: "user", content: "weather in Portland?" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "c1", toolName: "weather", input: { city: "Portland" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "weather",
            output: { type: "text", value: '{"temp":12}' },
          },
        ],
      },
      { role: "assistant", content: "Twelve degrees." },
    ]);
  });

  test("no seeded message is TEXT shaped like a tool call", () => {
    // The live incident: the digest line `[tool think({…}) → …]` in the
    // assistant's own turns was imitated, and the model later SPOKE its
    // tool-call channel markup instead of calling. The content check is over
    // every part, so a call smuggled into any text field fails here.
    const seeded = modelView([
      { type: "userTranscript.committed", text: "call the dentist" },
      { type: "tool.called", toolCallId: "c1", toolName: "think", args: { thought: "who" } },
      { type: "tool.completed", toolCallId: "c1", result: "ok" },
      {
        type: "tool.called",
        toolCallId: "c2",
        toolName: "prepare_call",
        args: { callee: "Dr. Ada" },
      },
      { type: "tool.completed", toolCallId: "c2", result: '{"ready":true}' },
      { type: "agentTranscript.committed", text: "Calling now." },
    ]);
    const texts = seeded.flatMap((m) =>
      typeof m.content === "string"
        ? [m.content]
        : m.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    );
    expect(texts).toEqual(["call the dentist", "Calling now."]);
    for (const text of texts) {
      expect(text).not.toContain("[tool ");
      expect(text).not.toContain("to=functions");
    }
    expect(seeded.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  test("a call with no reply after it is a pair on its own, before the next user turn", () => {
    expect(
      modelView([
        { type: "userTranscript.committed", text: "set a timer" },
        { type: "tool.called", toolCallId: "c1", toolName: "timer", args: { minutes: 5 } },
        { type: "tool.completed", toolCallId: "c1", result: "ok" },
        { type: "userTranscript.committed", text: "hello?" },
      ]).map((m) => m.role),
    ).toEqual(["user", "assistant", "tool", "user"]);
  });

  test("a result whose `tool.called` is gone is DROPPED, not rendered as text", () => {
    // The log's front was trimmed past the call: no name, no arguments, so no
    // pair can be built — and a text mention is exactly what was imitated.
    const seeded = modelView([
      { type: "tool.completed", toolCallId: "gone", result: "eta=tue" },
      { type: "agentTranscript.committed", text: "Tuesday." },
    ]);
    expect(seeded).toEqual([{ role: "assistant", content: "Tuesday." }]);
    expect(JSON.stringify(seeded)).not.toContain("eta=tue");
  });

  test("a PENDING call (no result) contributes nothing either", () => {
    const seeded = modelView([
      { type: "userTranscript.committed", text: "book it" },
      { type: "tool.called", toolCallId: "c1", toolName: "book", args: { day: "tue" } },
    ]);
    expect(seeded).toEqual([{ role: "user", content: "book it" }]);
  });

  test("a long result and long arguments are capped; a call id no provider takes is replaced", () => {
    const seeded = modelView([
      { type: "userTranscript.committed", text: "go" },
      {
        type: "tool.called",
        toolCallId: "tc:1/with.odd-chars",
        toolName: "think",
        args: { thought: "y".repeat(SEEDED_TOOL_ARGS_CHARS + 50), step: 2 },
      },
      {
        type: "tool.completed",
        toolCallId: "tc:1/with.odd-chars",
        result: "x".repeat(SEEDED_TOOL_RESULT_CHARS + 50),
      },
    ]);
    const call = seeded[1];
    const result = seeded[2];
    if (call?.role !== "assistant" || typeof call.content === "string") {
      throw new Error("expected a tool-call message");
    }
    if (result?.role !== "tool") throw new Error("expected a tool message");
    const callPart = call.content[0];
    const resultPart = result.content[0];
    if (callPart?.type !== "tool-call" || resultPart?.type !== "tool-result") {
      throw new Error("expected a call/result pair");
    }
    expect(callPart.toolCallId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(callPart.toolCallId.length).toBeLessThanOrEqual(MAX_SEEDED_TOOL_CALL_ID_CHARS);
    expect(resultPart.toolCallId).toBe(callPart.toolCallId);
    expect(callPart.input).toEqual({
      thought: `${"y".repeat(SEEDED_TOOL_ARG_VALUE_CHARS)}… (truncated)`,
      step: 2,
    });
    expect(resultPart.output).toEqual({
      type: "text",
      value: `${"x".repeat(SEEDED_TOOL_RESULT_CHARS)}… (truncated)`,
    });
  });

  test("two calls that reuse one id (two sessions of a client) get distinct seeded ids", () => {
    const seeded = modelView([
      { type: "tool.called", toolCallId: "call_1", toolName: "a", args: {} },
      { type: "tool.completed", toolCallId: "call_1", result: "first" },
      { type: "userTranscript.committed", text: "again" },
      { type: "tool.called", toolCallId: "call_1", toolName: "a", args: {} },
      { type: "tool.completed", toolCallId: "call_1", result: "second" },
    ]);
    const ids = seeded.flatMap((m) =>
      m.role === "tool"
        ? m.content.flatMap((p) => (p.type === "tool-result" ? [p.toolCallId] : []))
        : [],
    );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});
