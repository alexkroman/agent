import { describe, expect, test, vi } from "vitest";
import { loadFixture, silentLogger } from "./_test-utils.ts";
import type { S2sWebSocket } from "./s2s.ts";
import { connectS2s } from "./s2s.ts";

/** EventTarget-based WebSocket stub (standard API, no `.on()` adapter needed). */
function createWebSocketStub() {
  const target = new EventTarget();
  return Object.assign(target, {
    readyState: 0,
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: target.addEventListener.bind(target) as S2sWebSocket["addEventListener"],
    /** Simulate a server-side event for testing. */
    emit(event: string, ...args: unknown[]) {
      const builders: Record<string, () => Event> = {
        open: () => new Event("open"),
        message: () => new MessageEvent("message", { data: args[0] }),
        close: () => {
          const ev = new Event("close");
          if (typeof args[0] === "number") Object.assign(ev, { code: args[0] });
          if (typeof args[1] === "string") Object.assign(ev, { reason: args[1] });
          return ev;
        },
        error: () => {
          const msg = args[0] instanceof Error ? args[0].message : String(args[0]);
          const ev = new Event("error");
          Object.defineProperty(ev, "message", { value: msg });
          return ev;
        },
      };
      const build = builders[event];
      if (build) target.dispatchEvent(build());
    },
  });
}

const s2sConfig = { wssUrl: "wss://fake", inputSampleRate: 16_000, outputSampleRate: 16_000 };

function createTestS2s() {
  const raw = createWebSocketStub();
  const createWebSocket = () => {
    setTimeout(() => {
      raw.readyState = 1;
      raw.emit("open");
    }, 0);
    return raw;
  };
  return { raw, createWebSocket, logger: { ...silentLogger } };
}

async function setupHandle() {
  const { raw, createWebSocket, logger } = createTestS2s();
  const handle = await connectS2s({
    apiKey: "test-key",
    config: s2sConfig,
    createWebSocket,
    logger,
  });
  return { raw, handle, logger };
}

// ─── Fixture-based tests (real API responses from Kokoro TTS audio) ─────

describe("real API fixtures", () => {
  /**
   * Replay all fixture messages through the S2S handle and collect events.
   * Events are collected from both the 'ready'/'replyStarted'/'sessionExpired' special
   * events and the unified 'event' emitter, tagged with their source type.
   */
  async function replayFixture(fixtureName: string) {
    const { raw, handle } = await setupHandle();
    const events: { type: string; payload: unknown }[] = [];

    // Special events that are NOT in the 'event' emitter
    handle.on("ready", (p) => events.push({ type: "ready", payload: p }));
    handle.on("replyStarted", (p) => events.push({ type: "replyStarted", payload: p }));
    handle.on("sessionExpired", () => events.push({ type: "sessionExpired", payload: undefined }));
    handle.on("audio", (p) => events.push({ type: "audio", payload: p }));
    handle.on("error", (p) => events.push({ type: "error", payload: p }));

    // All protocol-shaped events via the unified 'event' emitter
    handle.on("event", (event) => events.push({ type: event.type, payload: event }));

    const fixtures = loadFixture<Record<string, unknown>[]>(fixtureName);
    for (const msg of fixtures) {
      raw.emit("message", Buffer.from(JSON.stringify(msg)));
    }

    return { events, fixtures, raw, handle };
  }

  // ── Session lifecycle ──────────────────────────────────────────────────

  test("parses real session.ready messages with extra fields (timestamp, config)", async () => {
    const { events } = await replayFixture("session-ready.json");

    const readyEvents = events.filter((e) => e.type === "ready");
    expect(readyEvents.length).toBeGreaterThan(0);
    expect((readyEvents[0]?.payload as { sessionId: string }).sessionId).toMatch(/^sess_/);
  });

  test("parses real session.updated messages — they are now silently dropped", async () => {
    const { events } = await replayFixture("session-updated.json");

    // session.updated is no longer dispatched — it is dropped in s2s.ts
    const updatedEvents = events.filter((e) => e.type === "session.updated");
    expect(updatedEvents.length).toBe(0);
  });

  // ── Greeting session ───────────────────────────────────────────────────

  test("greeting session produces correct event sequence", async () => {
    const { events } = await replayFixture("greeting-session-sequence.json");

    const types = events.map((e) => e.type);
    // session.updated is dropped, so first non-audio event is 'ready'
    expect(types[0]).toBe("ready");
    expect(types[1]).toBe("replyStarted");
    expect(types.filter((t) => t === "agent_transcript").length).toBeGreaterThan(0);
    expect(types).toContain("agent_transcript");
    expect(types.at(-1)).toBe("reply_done");
  });

  // ── Reply lifecycle ────────────────────────────────────────────────────

  test("real agent deltas include text from delta field", async () => {
    const { events } = await replayFixture("reply-lifecycle.json");

    const deltas = events.filter(
      (e) => e.type === "agent_transcript" && (e.payload as { isFinal: boolean }).isFinal === false,
    );
    expect(deltas.length).toBeGreaterThan(0);
    for (const d of deltas) {
      expect(typeof (d.payload as { text: string }).text).toBe("string");
    }
  });

  test("real transcript.agent has isFinal:true and _interrupted field", async () => {
    const { events } = await replayFixture("reply-lifecycle.json");

    const transcripts = events.filter(
      (e) => e.type === "agent_transcript" && (e.payload as { isFinal: boolean }).isFinal === true,
    );
    expect(transcripts.length).toBe(1);
    const payload = transcripts[0]?.payload as {
      type: string;
      text: string;
      isFinal: boolean;
      _interrupted: boolean;
    };
    expect(payload.isFinal).toBe(true);
    expect(payload._interrupted).toBe(false);
  });

  // ── Audio ──────────────────────────────────────────────────────────────

  test("real reply.audio messages decode to Uint8Array", async () => {
    const { events } = await replayFixture("reply-audio-samples.json");

    const audioEvents = events.filter((e) => e.type === "audio");
    expect(audioEvents.length).toBeGreaterThan(0);
    for (const e of audioEvents) {
      expect((e.payload as { audio: Uint8Array }).audio).toBeInstanceOf(Uint8Array);
    }
  });

  // ── User speech recognition (from Kokoro TTS audio) ────────────────────

  test("user speech events from real STT (Kokoro-generated audio)", async () => {
    const { events } = await replayFixture("user-speech-recognition.json");

    const types = events.map((e) => e.type);
    expect(types).toContain("speech_started");
    expect(types).toContain("speech_stopped");
    expect(types).toContain("user_transcript");

    // Verify the STT correctly transcribed the Kokoro audio
    const transcripts = events.filter(
      (e) => e.type === "user_transcript" && (e.payload as { isFinal: boolean }).isFinal === true,
    );
    const texts = transcripts.map((e) => (e.payload as { text: string }).text);
    expect(texts.some((t) => t.toLowerCase().includes("space"))).toBe(true);
    expect(texts.some((t) => t.toLowerCase().includes("weather"))).toBe(true);
  });

  // ── Simple question flow ───────────────────────────────────────────────

  test("simple question: greeting → user speech → agent response", async () => {
    const { events } = await replayFixture("simple-question-sequence.json");

    const types = events.map((e) => e.type);

    // Session setup: session.updated is dropped; first events are ready + replyStarted
    expect(types[0]).toBe("ready");
    expect(types[1]).toBe("replyStarted");

    // Greeting reply
    expect(types).toContain("replyStarted");

    // User speech recognition
    expect(types).toContain("speech_started");
    expect(types).toContain("user_transcript");

    // Agent response
    const finalAgentTranscripts = events.filter(
      (e) => e.type === "agent_transcript" && (e.payload as { isFinal: boolean }).isFinal === true,
    );
    expect(finalAgentTranscripts.length).toBe(2); // greeting + answer

    // Two complete reply cycles (greeting + answer)
    expect(types.filter((t) => t === "reply_done").length).toBe(2);
  });

  // ── Tool call flow ─────────────────────────────────────────────────────

  test("tool call: user asks weather → tool_call event dispatched with parsed args", async () => {
    const { events } = await replayFixture("tool-calls.json");

    const toolCallEvents = events.filter((e) => e.type === "tool_call");
    expect(toolCallEvents.length).toBe(1);
    const tc = toolCallEvents[0]?.payload as {
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    };
    expect(tc.toolName).toBe("get_weather");
    expect(tc.args.city).toBe("San Francisco");
    expect(tc.toolCallId).toMatch(/^chatcmpl-tool-/);
  });

  test("tool call sequence: greeting → user speech → tool call → agent response", async () => {
    const { events } = await replayFixture("tool-call-sequence.json");

    const types = events.map((e) => e.type);

    // Session setup: session.updated dropped; first events are ready + replyStarted
    expect(types[0]).toBe("ready");
    expect(types[1]).toBe("replyStarted");

    // User speech was recognized
    expect(types).toContain("user_transcript");
    const userTx = events.find(
      (e) => e.type === "user_transcript" && (e.payload as { isFinal: boolean }).isFinal === true,
    );
    expect((userTx?.payload as { text: string }).text.toLowerCase()).toContain("weather");

    // Tool was called
    expect(types).toContain("tool_call");
    const toolCall = events.find((e) => e.type === "tool_call");
    expect((toolCall?.payload as { toolName: string }).toolName).toBe("get_weather");

    // Agent responded after tool result
    const finalAgentTxs = events.filter(
      (e) => e.type === "agent_transcript" && (e.payload as { isFinal: boolean }).isFinal === true,
    );
    expect(finalAgentTxs.length).toBe(2); // greeting + tool response
    const toolResponse = finalAgentTxs.at(-1)?.payload as { text: string };
    expect(toolResponse.text.toLowerCase()).toContain("san francisco");
  });
});
