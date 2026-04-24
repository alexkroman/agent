import { describe, expect, test, vi } from "vitest";
import { DEFAULT_SYSTEM_PROMPT } from "../sdk/types.ts";
import type { SessionCore, SessionCoreOptions } from "./session-core.ts";
import { createSessionCore } from "./session-core.ts";
import type { Transport } from "./transports/types.ts";

function makeSink() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const rec =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  return {
    sink: {
      get open() {
        return true;
      },
      config: rec("config"),
      audio: rec("audio"),
      audioDone: rec("audioDone"),
      speechStarted: rec("speechStarted"),
      speechStopped: rec("speechStopped"),
      userTranscript: rec("userTranscript"),
      agentTranscript: rec("agentTranscript"),
      toolCall: rec("toolCall"),
      toolCallDone: rec("toolCallDone"),
      replyDone: rec("replyDone"),
      cancelled: rec("cancelled"),
      reset: rec("reset"),
      idleTimeout: rec("idleTimeout"),
      error: rec("error"),
      customEvent: rec("customEvent"),
    },
    calls,
  };
}

function makeTransport(): Transport & { starts: number; stops: number } {
  let starts = 0,
    stops = 0;
  return {
    start: async () => {
      starts++;
    },
    stop: async () => {
      stops++;
    },
    sendUserAudio: vi.fn(),
    sendToolResult: vi.fn(),
    cancelReply: vi.fn(),
    get starts() {
      return starts;
    },
    get stops() {
      return stops;
    },
  };
}

function makeCore(overrides: Partial<SessionCoreOptions> = {}): {
  core: SessionCore;
  sink: ReturnType<typeof makeSink>;
  transport: ReturnType<typeof makeTransport>;
} {
  const sink = makeSink();
  const transport = makeTransport();
  const core = createSessionCore({
    id: "s-test",
    agent: "test-agent",
    client: sink.sink,
    agentConfig: { name: "test", systemPrompt: DEFAULT_SYSTEM_PROMPT, greeting: "" },
    executeTool: vi.fn(async () => "ok"),
    transport,
    ...overrides,
  });
  return { core, sink, transport };
}

describe("createSessionCore — lifecycle", () => {
  test("start/stop calls transport", async () => {
    const { core, transport } = makeCore();
    await core.start();
    expect(transport.starts).toBe(1);
    await core.stop();
    expect(transport.stops).toBe(1);
  });
  test("stop is idempotent", async () => {
    const { core, transport } = makeCore();
    await core.start();
    await core.stop();
    await core.stop();
    expect(transport.stops).toBe(1);
  });
  test("post-stop onAudio does not reschedule the idle timer", async () => {
    vi.useFakeTimers();
    try {
      const { core, sink } = makeCore({
        agentConfig: {
          name: "test",
          systemPrompt: DEFAULT_SYSTEM_PROMPT,
          greeting: "",
          idleTimeoutMs: 1000,
        } as unknown as SessionCoreOptions["agentConfig"],
      });
      await core.start();
      await core.stop();
      core.onAudio(new Uint8Array([1]));
      vi.advanceTimersByTime(5000);
      expect(sink.calls.some((c) => c.method === "idleTimeout")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createSessionCore — client inbound", () => {
  test("onAudio forwards to transport", async () => {
    const { core, transport } = makeCore();
    await core.start();
    const audio = new Uint8Array([1, 2, 3]);
    core.onAudio(audio);
    expect(transport.sendUserAudio).toHaveBeenCalledWith(audio);
  });
  test("onCancel cancels the reply and emits cancelled", async () => {
    const { core, transport, sink } = makeCore();
    await core.start();
    core.onCancel();
    expect(transport.cancelReply).toHaveBeenCalledOnce();
    expect(sink.calls.some((c) => c.method === "cancelled")).toBe(true);
  });
  test("onReset emits reset", async () => {
    const { core, sink } = makeCore();
    await core.start();
    core.onReset();
    expect(sink.calls.some((c) => c.method === "reset")).toBe(true);
  });
});

describe("createSessionCore — transport inbound (basic)", () => {
  test("onAudioChunk forwards to sink", async () => {
    const { core, sink } = makeCore();
    await core.start();
    const pcm = new Uint8Array([9, 8, 7]);
    core.onAudioChunk(pcm);
    const call = sink.calls.find((c) => c.method === "audio");
    expect(call).toBeDefined();
    expect(call?.args[0]).toBe(pcm);
  });
  test("onUserTranscript pushes to history and emits", async () => {
    const { core, sink } = makeCore();
    await core.start();
    core.onUserTranscript("hello");
    expect(sink.calls.some((c) => c.method === "userTranscript")).toBe(true);
  });
});
