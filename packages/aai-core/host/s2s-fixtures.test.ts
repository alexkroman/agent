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
  /** Replay all fixture messages through the S2S handle and collect events. */
  async function replayFixture(fixtureName: string) {
    const { raw, handle } = await setupHandle();
    const events: { type: string; payload: unknown }[] = [];

    for (const event of [
      "ready",
      "sessionUpdated",
      "replyStarted",
      "agentTranscriptDelta",
      "agentTranscript",
      "replyDone",
      "speechStarted",
      "speechStopped",
      "userTranscriptDelta",
      "userTranscript",
      "toolCall",
      "audio",
      "error",
      "sessionExpired",
    ] as const) {
      handle.on(event, (p: unknown) => events.push({ type: event, payload: p }));
    }

    const fixtures = loadFixture<Record<string, unknown>[]>(fixtureName);
    for (const msg of fixtures) {
      raw.emit("message", Buffer.from(JSON.stringify(msg)));
    }

    return { events, fixtures, raw, handle };
  }

  // ── Session lifecycle ──────────────────────────────────────────────────

  test("parses real session.ready messages with extra fields (timestamp, config)", async () => {
    const { events } = await replayFixture("session-ready.json");

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.type === "ready")).toBe(true);
    expect((events[0]?.payload as { sessionId: string }).sessionId).toMatch(/^sess_/);
  });

  test("parses real session.updated messages with config echo-back", async () => {
    const { events } = await replayFixture("session-updated.json");

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.type === "sessionUpdated")).toBe(true);
  });

  // ── Greeting session ───────────────────────────────────────────────────

  test("greeting session produces correct event sequence", async () => {
    const { events } = await replayFixture("greeting-session-sequence.json");

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("sessionUpdated");
    expect(types[1]).toBe("ready");
    expect(types[2]).toBe("replyStarted");
    expect(types.filter((t) => t === "agentTranscriptDelta").length).toBeGreaterThan(0);
    expect(types).toContain("agentTranscript");
    expect(types.at(-1)).toBe("replyDone");
  });

  // ── Reply lifecycle ────────────────────────────────────────────────────

  test("real agent deltas include extra fields (reply_id, item_id, start_ms, end_ms)", async () => {
    const { events } = await replayFixture("reply-lifecycle.json");

    const deltas = events.filter((e) => e.type === "agentTranscriptDelta");
    expect(deltas.length).toBeGreaterThan(0);
    // Parser extracts the delta field as text
    for (const d of deltas) {
      expect(typeof (d.payload as { text: string }).text).toBe("string");
    }
  });

  test("real transcript.agent has reply_id and item_id", async () => {
    const { events } = await replayFixture("reply-lifecycle.json");

    const transcripts = events.filter((e) => e.type === "agentTranscript");
    expect(transcripts.length).toBe(1);
    const payload = transcripts[0]?.payload as {
      text: string;
      replyId: string;
      itemId: string;
      interrupted: boolean;
    };
    expect(payload.replyId).toMatch(/^resp_/);
    expect(payload.itemId).toMatch(/^msg_/);
    expect(payload.interrupted).toBe(false);
  });

  // ── Audio ──────────────────────────────────────────────────────────────

  test("real reply.audio messages decode to Uint8Array", async () => {
    const { events } = await replayFixture("reply-audio-samples.json");

    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.type).toBe("audio");
      expect((e.payload as { audio: Uint8Array }).audio).toBeInstanceOf(Uint8Array);
    }
  });

  // ── User speech recognition (from Kokoro TTS audio) ────────────────────

  test("user speech events from real STT (Kokoro-generated audio)", async () => {
    const { events } = await replayFixture("user-speech-recognition.json");

    const types = events.map((e) => e.type);
    expect(types).toContain("speechStarted");
    expect(types).toContain("speechStopped");
    expect(types).toContain("userTranscript");

    // Verify the STT correctly transcribed the Kokoro audio
    const transcripts = events.filter((e) => e.type === "userTranscript");
    const texts = transcripts.map((e) => (e.payload as { text: string }).text);
    expect(texts.some((t) => t.toLowerCase().includes("space"))).toBe(true);
    expect(texts.some((t) => t.toLowerCase().includes("weather"))).toBe(true);
  });

  // ── Simple question flow ───────────────────────────────────────────────

  test("simple question: greeting → user speech → agent response", async () => {
    const { events } = await replayFixture("simple-question-sequence.json");

    const types = events.map((e) => e.type);

    // Session setup
    expect(types[0]).toBe("sessionUpdated");
    expect(types[1]).toBe("ready");

    // Greeting reply
    expect(types).toContain("replyStarted");

    // User speech recognition
    expect(types).toContain("speechStarted");
    expect(types).toContain("userTranscript");

    // Agent response
    expect(types.filter((t) => t === "agentTranscript").length).toBe(2); // greeting + answer

    // Two complete reply cycles (greeting + answer)
    expect(types.filter((t) => t === "replyDone").length).toBe(2);
  });

  // ── Tool call flow ─────────────────────────────────────────────────────

  test("tool call: user asks weather → tool.call dispatched with parsed args", async () => {
    const { events } = await replayFixture("tool-calls.json");

    expect(events.length).toBe(1);
    const tc = events[0]?.payload as {
      callId: string;
      name: string;
      args: Record<string, unknown>;
    };
    expect(tc.name).toBe("get_weather");
    expect(tc.args.city).toBe("San Francisco");
    expect(tc.callId).toMatch(/^chatcmpl-tool-/);
  });

  test("tool call sequence: greeting → user speech → tool call → agent response", async () => {
    const { events } = await replayFixture("tool-call-sequence.json");

    const types = events.map((e) => e.type);

    // Session setup
    expect(types[0]).toBe("sessionUpdated");
    expect(types[1]).toBe("ready");

    // User speech was recognized
    expect(types).toContain("userTranscript");
    const userTx = events.find((e) => e.type === "userTranscript");
    expect((userTx?.payload as { text: string }).text.toLowerCase()).toContain("weather");

    // Tool was called
    expect(types).toContain("toolCall");
    const toolCall = events.find((e) => e.type === "toolCall");
    expect((toolCall?.payload as { name: string }).name).toBe("get_weather");

    // Agent responded after tool result
    const agentTxs = events.filter((e) => e.type === "agentTranscript");
    expect(agentTxs.length).toBe(2); // greeting + tool response
    const toolResponse = agentTxs.at(-1)?.payload as { text: string };
    expect(toolResponse.text.toLowerCase()).toContain("san francisco");
  });
});
