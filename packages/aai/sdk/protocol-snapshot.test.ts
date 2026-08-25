// Copyright 2025 the AAI authors. MIT license.
/**
 * Wire format snapshot tests for the WebSocket protocol.
 *
 * These ensure that changes to Zod schemas in protocol.ts don't
 * accidentally alter the wire format. If a snapshot breaks, it
 * signals a potentially breaking protocol change.
 */
import { describe, expect, test } from "vitest";
import { TOOL_EXECUTION_TIMEOUT_MS } from "./constants.ts";
import type { SessionCommand, SessionEvent, SessionEventBody } from "./protocol.ts";
import { EVENT_ID_PREFIX, SessionCommandSchema, SessionEventSchema } from "./protocol.ts";

/**
 * The envelope every event carries on the wire, so the cases below stay about
 * the SHAPE they are testing. A fixed id and time, because nothing here asserts
 * on either — {@link envelopeCases} is where the envelope itself is checked.
 */
const META = { id: `${EVENT_ID_PREFIX}01ARZ3NDEKTSV4RRFFQ69G5FAV`, at: 1_700_000_000_000 };

/** Stamp a body, so a case reads as the event an emitter writes. */
function stamped(body: SessionEventBody): SessionEvent {
  return { ...body, meta: META };
}

describe("protocol constants", () => {
  // The one wire constant `compat-fixtures/` does not carry. Both sample rates
  // and the error-code list used to be pinned here too, and `protocol-compat.
  // test.ts` pins them against the fixture — better, and in the error codes' case
  // in the OPPOSITE DIRECTION: the fixture asserts the current options are a
  // SUPERSET of the recorded list, which is the safe claim (adding a code is
  // harmless, removing one breaks a deployed client), where the inline snapshot
  // asserted exact equality. That fired on the safe change and yielded to the
  // dangerous one the moment anybody ran `-u`.
  test("timeout constants", () => {
    expect(TOOL_EXECUTION_TIMEOUT_MS).toMatchInlineSnapshot("30000");
  });
});

describe("server→client event wire format", () => {
  // The LABEL is the type now, so it is derived rather than restated. The old
  // list carried both and they had already drifted apart from each other.
  const valid: SessionEventBody[] = [
    { type: "speech.started" },
    { type: "speech.stopped" },
    { type: "user-transcript.updated", text: "hel", eotConfidence: 0.42 },
    { type: "user-transcript.committed", text: "hello" },
    { type: "agent-transcript.updated", text: "resp" },
    { type: "agent-transcript.committed", text: "response" },
    { type: "tool.called", toolCallId: "tc1", toolName: "web_search", args: { query: "weather" } },
    { type: "tool.completed", toolCallId: "tc1", result: "72F" },
    { type: "reply.completed" },
    { type: "reply.cancelled" },
    { type: "session.reset" },
    { type: "session.timed-out" },
    { type: "session.configured", audioFormat: "pcm16", sampleRate: 16_000, ttsSampleRate: 24_000 },
    { type: "audio.completed" },
    { type: "error.reported", code: "stt", message: "Speech recognition failed", fatal: true },
    { type: "custom.emitted", event: "game_state", data: { hp: 10 } },
    { type: "state.updated", state: { items: [] } },
    {
      type: "history.restored",
      messages: [
        { role: "user", content: "two large pepperoni" },
        { role: "assistant", content: "Got it." },
      ],
      // Anchored to the user turn it followed, settled with its result — the
      // JOIN of `tool.called` and `tool.completed` a restore sends.
      toolCalls: [
        {
          callId: "c1",
          name: "place_order",
          args: { size: "large" },
          status: "done",
          result: '{"ok":true}',
          afterMessageIndex: 0,
        },
      ],
    },
  ];

  test.each(valid.map((body) => [body.type, body] as const))(
    "%s parses successfully",
    (_type, body) => {
      expect(SessionEventSchema.safeParse(stamped(body)).success).toBe(true);
    },
  );

  test("every event name is covered above", () => {
    // The list is hand-written, so nothing otherwise notices a new event going
    // unpinned — and a new event is exactly when the wire format is changing.
    expect(new Set(valid.map((body) => body.type))).toEqual(
      new Set(SessionEventSchema.options.map((option) => option.shape.type.value)),
    );
  });

  test("rejects unknown event type", () => {
    expect(SessionEventSchema.safeParse({ type: "bogus", meta: META }).success).toBe(false);
  });

  test("requires the envelope", () => {
    // The one thing the old protocol had no equivalent of, so it is pinned
    // rather than assumed: an event with no `meta` is not a session event, and a
    // reader that tolerated one could not key on `meta.id` at all.
    expect(SessionEventSchema.safeParse({ type: "speech.started" }).success).toBe(false);
    expect(
      SessionEventSchema.safeParse({ type: "speech.started", meta: { at: META.at } }).success,
    ).toBe(false);
  });

  test("rejects an id that does not name its own kind", () => {
    expect(
      SessionEventSchema.safeParse({
        type: "speech.started",
        meta: { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", at: META.at },
      }).success,
    ).toBe(false);
  });

  test("rejects invalid error code", () => {
    expect(
      SessionEventSchema.safeParse({
        type: "error.reported",
        meta: META,
        code: "invalid_code",
        message: "x",
      }).success,
    ).toBe(false);
  });

  test("rejects custom.emitted with empty event name", () => {
    expect(
      SessionEventSchema.safeParse({ type: "custom.emitted", meta: META, event: "", data: null })
        .success,
    ).toBe(false);
  });

  test("rejects tool.completed with oversized result", () => {
    expect(
      SessionEventSchema.safeParse({
        type: "tool.completed",
        meta: META,
        toolCallId: "tc1",
        result: "x".repeat(4001),
      }).success,
    ).toBe(false);
  });
});

describe("client→server command wire format", () => {
  const valid: SessionCommand[] = [
    { type: "audio_ready" },
    { type: "cancel" },
    { type: "reset" },
    { type: "playback_progress", bufferedMs: 1200 },
    { type: "tool_result", toolCallId: "tc1", result: "ok" },
  ];

  test.each(valid.map((msg) => [msg.type, msg] as const))(
    "%s parses successfully",
    (_type, msg) => {
      expect(SessionCommandSchema.safeParse(msg).success).toBe(true);
    },
  );

  test("rejects unknown message type", () => {
    expect(SessionCommandSchema.safeParse({ type: "bogus" }).success).toBe(false);
  });

  test("there is no `history` command", () => {
    // Deleted with the client-side replay it existed for: a reconnecting client
    // used to push its own `messages` back, which made it the authority on what
    // the agent remembered. The server restores from its retained event stream
    // now, so accepting this frame would be a second mechanism doing the same
    // job — with the client's the one that actually ran.
    expect(
      SessionCommandSchema.safeParse({
        type: "history",
        messages: [{ role: "user", content: "Hello" }],
      }).success,
    ).toBe(false);
  });

  test("commands and events do not share a namespace", () => {
    // The split is the point of two unions: a command is a REQUEST and an event
    // is a FACT, and one union with one shape let `cancel` sit beside
    // `reply.completed` with nothing but the name to tell them apart.
    const commands: string[] = SessionCommandSchema.options.map((o) => o.shape.type.value);
    const events: string[] = SessionEventSchema.options.map((o) => o.shape.type.value);
    expect(commands.filter((type) => events.includes(type))).toEqual([]);
  });
});

describe("the handshake and the turn boundary are ordinary events", () => {
  // Both used to be declared outside the event vocabulary — `config` and
  // `audio_done` on a second union — which is exactly what made them the two
  // frames no event stream could contain.
  test("session.configured carries the audio negotiation and the session id", () => {
    const event = stamped({
      type: "session.configured",
      audioFormat: "pcm16",
      sampleRate: 16_000,
      ttsSampleRate: 24_000,
      sessionId: "s-1",
    });
    expect(SessionEventSchema.safeParse(event).success).toBe(true);
  });

  test("audio.completed is an event, not a sink method", () => {
    expect(SessionEventSchema.safeParse(stamped({ type: "audio.completed" })).success).toBe(true);
  });
});
