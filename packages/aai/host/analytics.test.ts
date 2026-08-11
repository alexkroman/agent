// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import type { ClientEvent, ClientSink } from "../sdk/protocol.ts";
import { toolError } from "../sdk/utils.ts";
import { type AnalyticsEvent, type AnalyticsSink, createSessionAnalytics } from "./analytics.ts";
import type { Logger } from "./runtime-config.ts";

/** A sink that collects, plus a controllable clock the recorder reads. */
function harness(startAt = 1000) {
  const events: AnalyticsEvent[] = [];
  const sink: AnalyticsSink = { record: (e) => events.push(e) };
  let clock = startAt;
  const analytics = createSessionAnalytics({
    sink,
    sessionId: "sess-1",
    agent: "my-agent",
    now: () => clock,
  });
  return {
    events,
    analytics,
    advance(ms: number) {
      clock += ms;
    },
    of(kind: AnalyticsEvent["kind"]) {
      return events.filter((e) => e.kind === kind);
    },
  };
}

function fakeSink(): ClientSink & { events: ClientEvent[]; chunks: number; doneCount: number } {
  const sink = {
    open: true,
    events: [] as ClientEvent[],
    chunks: 0,
    doneCount: 0,
    event(e: ClientEvent) {
      sink.events.push(e);
    },
    playAudioChunk() {
      sink.chunks += 1;
    },
    playAudioDone() {
      sink.doneCount += 1;
    },
  };
  return sink;
}

describe("session analytics", () => {
  test("records a session_start naming the agent", () => {
    const h = harness();
    h.analytics.start();
    expect(h.events).toEqual([
      { ts: 1000, sessionId: "sess-1", kind: "session_start", turn: 0, name: "my-agent" },
    ]);
  });

  test("times a turn from the committed user transcript to the first audio frame", () => {
    const h = harness();
    const client = h.analytics.wrapSink(fakeSink());
    client.event({ type: "user_transcript", text: "what is my balance" });
    h.advance(420);
    client.playAudioChunk(new Uint8Array([1, 2]));
    h.advance(80);
    client.event({ type: "agent_transcript", text: "Your balance is $12." });
    client.event({ type: "reply_done" });

    const [turn] = h.of("agent_turn");
    expect(turn?.durationMs).toBe(500);
    expect(turn?.data).toEqual({ firstAudioMs: 420 });
    expect(turn?.ok).toBe(true);
    expect(turn?.text).toBe("Your balance is $12.");
  });

  test("numbers turns so a conversation can be reconstructed in order", () => {
    const h = harness();
    const client = h.analytics.wrapSink(fakeSink());
    client.event({ type: "user_transcript", text: "one" });
    client.event({ type: "reply_done" });
    client.event({ type: "user_transcript", text: "two" });
    client.event({ type: "reply_done" });
    expect(h.of("user_turn").map((e) => e.turn)).toEqual([1, 2]);
    expect(h.of("agent_turn").map((e) => e.turn)).toEqual([1, 2]);
  });

  test("omits firstAudioMs when a turn produced no audio at all", () => {
    // Averaging a zero in is how a silent (broken) agent scores as the fastest
    // one in the fleet.
    const h = harness();
    const client = h.analytics.wrapSink(fakeSink());
    client.event({ type: "user_transcript", text: "hello" });
    h.advance(50);
    client.event({ type: "reply_done" });
    expect(h.of("agent_turn")[0]?.data).toEqual({});
  });

  test("a cancelled reply the caller could hear is a barge-in", () => {
    const h = harness();
    const client = h.analytics.wrapSink(fakeSink());
    client.event({ type: "user_transcript", text: "tell me everything" });
    h.advance(200);
    client.playAudioChunk(new Uint8Array([1]));
    h.advance(300);
    client.event({ type: "cancelled" });

    expect(h.of("agent_turn")[0]).toMatchObject({ ok: false, data: { interrupted: true } });
    expect(h.of("barge_in")[0]?.durationMs).toBe(500);
  });

  test("a cancelled reply that never spoke is not a barge-in", () => {
    const h = harness();
    const client = h.analytics.wrapSink(fakeSink());
    client.event({ type: "user_transcript", text: "wait" });
    client.event({ type: "cancelled" });
    expect(h.of("agent_turn")[0]?.ok).toBe(false);
    expect(h.of("barge_in")).toEqual([]);
  });

  test("audio outside any reply does not make the NEXT reply a barge-in", () => {
    // The greeting plays before the first user turn. A separate "did it
    // speak" flag latched true there and never reset, so the next silent
    // cancelled reply was recorded as an interruption of nothing.
    const h = harness();
    const client = h.analytics.wrapSink(fakeSink());
    client.playAudioChunk(new Uint8Array([1]));
    client.event({ type: "user_transcript", text: "hello" });
    client.event({ type: "cancelled" });
    expect(h.of("barge_in")).toEqual([]);
  });

  test("a new user turn settles a reply the transport never closed", () => {
    const h = harness();
    const client = h.analytics.wrapSink(fakeSink());
    client.event({ type: "user_transcript", text: "one" });
    client.event({ type: "user_transcript", text: "two" });
    // Turns and replies stay paired even when the provider just moves on.
    expect(h.of("agent_turn")).toHaveLength(1);
    expect(h.of("user_turn")).toHaveLength(2);
  });

  test("records errors with their code and fatality", () => {
    const h = harness();
    const client = h.analytics.wrapSink(fakeSink());
    client.event({ type: "error", code: "stt", message: "socket closed", fatal: false });
    expect(h.of("error")[0]).toMatchObject({
      name: "stt",
      text: "socket closed",
      ok: false,
      data: { fatal: false },
    });
  });

  test("forwards every event and audio frame to the wrapped sink unchanged", () => {
    const h = harness();
    const inner = fakeSink();
    const client = h.analytics.wrapSink(inner);
    client.event({ type: "user_transcript", text: "hi" });
    client.playAudioChunk(new Uint8Array([1]));
    client.playAudioDone();
    expect(inner.events).toEqual([{ type: "user_transcript", text: "hi" }]);
    expect(inner.chunks).toBe(1);
    expect(inner.doneCount).toBe(1);
    expect(client.open).toBe(true);
  });

  test("a recorder failure never breaks the session", () => {
    const events: AnalyticsEvent[] = [];
    const analytics = createSessionAnalytics({
      sink: {
        record(e) {
          if (e.kind === "user_turn") throw new Error("sink exploded");
          events.push(e);
        },
      },
      sessionId: "s",
      agent: "a",
    });
    const inner = fakeSink();
    const client = analytics.wrapSink(inner);
    expect(() => client.event({ type: "user_transcript", text: "hi" })).not.toThrow();
    // The event still reached the client — that is the part that matters.
    expect(inner.events).toHaveLength(1);
  });

  // The outcome is DECIDED in tool-executor.ts (see its own spec); this side
  // only has to carry it through unchanged. Reading `ok` off the result
  // string is precisely what that split removed.
  test("records the tool outcome the executor reported, whatever the result reads like", () => {
    const h = harness();
    h.analytics.recordToolCall({ name: "good", ok: true, durationMs: 75, result: "ok" });
    h.analytics.recordToolCall({
      name: "bad",
      ok: false,
      durationMs: 30,
      result: toolError("no such order"),
    });

    expect(h.of("tool_call")).toMatchObject([
      { name: "good", ok: true, durationMs: 75, text: "ok" },
      { name: "bad", ok: false, durationMs: 30 },
    ]);
  });

  test("records log lines and still calls the underlying logger", () => {
    const h = harness();
    const inner: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const logger = h.analytics.wrapLogger(inner);
    logger.warn("slow reply_done dispatch", { sid: "sess-1", durationMs: 900 });
    logger.debug("per-frame noise");

    expect(h.of("log")).toMatchObject([
      { level: "warn", text: "slow reply_done dispatch", data: { sid: "sess-1", durationMs: 900 } },
    ]);
    expect(inner.warn).toHaveBeenCalledWith("slow reply_done dispatch", {
      sid: "sess-1",
      durationMs: 900,
    });
    // debug is passed through unrecorded — it is per-audio-frame in places.
    expect(inner.debug).toHaveBeenCalledWith("per-frame noise");
  });

  test("stringifies non-primitive log context rather than dropping it", () => {
    const h = harness();
    const logger = h.analytics.wrapLogger({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    });
    logger.error("tool failed", { error: { name: "TypeError" } });
    expect(h.of("log")[0]?.data).toEqual({ error: '{"name":"TypeError"}' });
  });

  test("session_end carries the duration and the session's totals", async () => {
    const h = harness();
    h.analytics.start();
    const client = h.analytics.wrapSink(fakeSink());
    client.event({ type: "user_transcript", text: "hi" });
    client.event({ type: "reply_done" });
    client.event({ type: "error", code: "tool", message: "x" });
    h.analytics.recordToolCall({ name: "t", ok: true, durationMs: 5, result: "ok" });
    h.advance(9000);
    h.analytics.end("client_closed");

    expect(h.of("session_end")[0]).toMatchObject({
      durationMs: 9000,
      name: "client_closed",
      data: { turns: 1, errors: 1, tools: 1 },
    });
  });

  test("an idle timeout names itself as the end reason", () => {
    const h = harness();
    const client = h.analytics.wrapSink(fakeSink());
    client.event({ type: "idle_timeout" });
    h.analytics.end();
    expect(h.of("session_end")[0]?.name).toBe("idle_timeout");
  });

  test("a session torn down mid-reply still emits that turn", () => {
    // Otherwise every hang-up-while-the-agent-is-talking session is missing
    // exactly the turn worth looking at.
    const h = harness();
    const client = h.analytics.wrapSink(fakeSink());
    client.event({ type: "user_transcript", text: "hello?" });
    h.advance(120);
    client.playAudioChunk(new Uint8Array([1]));
    h.analytics.end();
    expect(h.of("agent_turn")[0]).toMatchObject({ ok: false, data: { interrupted: true } });
  });

  test("end is idempotent", () => {
    const h = harness();
    h.analytics.end();
    h.analytics.end();
    expect(h.of("session_end")).toHaveLength(1);
  });

  test("truncates transcripts so one row cannot be unbounded", () => {
    const h = harness();
    const client = h.analytics.wrapSink(fakeSink());
    client.event({ type: "user_transcript", text: "x".repeat(5000) });
    const text = h.of("user_turn")[0]?.text ?? "";
    expect(text.length).toBe(2001);
    expect(text.endsWith("…")).toBe(true);
  });

  test("does not record partials, speech edges, or state snapshots", () => {
    // Partials alone would outnumber every other kind by orders of magnitude.
    const h = harness();
    const client = h.analytics.wrapSink(fakeSink());
    client.event({ type: "user_transcript_partial", text: "par" });
    client.event({ type: "speech_started" });
    client.event({ type: "speech_stopped" });
    client.event({ type: "agent_state", state: { big: "payload" } });
    expect(h.events).toEqual([]);
  });
});
