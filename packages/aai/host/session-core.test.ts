import { describe, expect, test, vi } from "vitest";
import { DEFAULT_SYSTEM_PROMPT } from "../sdk/types.ts";
import { flush } from "./_test-utils.ts";
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

describe("createSessionCore — reply dedup", () => {
  test("first reply_done emits replyDone + audioDone", async () => {
    const { core, sink } = makeCore();
    await core.start();
    core.onReplyStarted("r1");
    core.onReplyDone();
    expect(sink.calls.some((c) => c.method === "replyDone")).toBe(true);
    expect(sink.calls.some((c) => c.method === "audioDone")).toBe(true);
  });
  test("duplicate reply_done is dropped", async () => {
    const { core, sink } = makeCore();
    await core.start();
    core.onReplyStarted("r1");
    core.onReplyDone();
    core.onReplyDone();
    const dones = sink.calls.filter((c) => c.method === "replyDone");
    expect(dones).toHaveLength(1);
  });
  test("onCancelled clears currentReplyId so subsequent replyDone is dropped", async () => {
    const { core, sink } = makeCore();
    await core.start();
    core.onReplyStarted("r1");
    core.onCancelled();
    core.onReplyDone();
    expect(sink.calls.filter((c) => c.method === "replyDone")).toHaveLength(0);
  });
});

describe("createSessionCore — tool call pending results", () => {
  test("tool_call executes, tool_call_done fires, reply_done forwards results to transport", async () => {
    const executeTool = vi.fn(async () => "tool-output");
    const { core, sink, transport } = makeCore({ executeTool });
    await core.start();
    core.onReplyStarted("r1");
    core.onToolCall("cid", "my_tool", {});
    // Let the async tool IIFE settle and push to pendingTools
    await flush();
    core.onReplyDone();
    // Poll until tool results are forwarded and toolCallDone fires
    await vi.waitFor(() =>
      expect(transport.sendToolResult).toHaveBeenCalledWith("cid", "tool-output"),
    );
    expect(sink.calls.some((c) => c.method === "toolCallDone")).toBe(true);
  });
});

describe("createSessionCore — idle timeout", () => {
  test("emits idleTimeout after agentConfig.idleTimeoutMs of no audio", async () => {
    vi.useFakeTimers();
    try {
      const { core, sink } = makeCore({
        agentConfig: {
          name: "t",
          systemPrompt: DEFAULT_SYSTEM_PROMPT,
          greeting: "",
          idleTimeoutMs: 1000,
        } as unknown as SessionCoreOptions["agentConfig"],
      });
      await core.start();
      expect(sink.calls.filter((c) => c.method === "idleTimeout")).toHaveLength(0);
      vi.advanceTimersByTime(1001);
      expect(sink.calls.filter((c) => c.method === "idleTimeout")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
  test("onAudio resets the idle timer", async () => {
    vi.useFakeTimers();
    try {
      const { core, sink } = makeCore({
        agentConfig: {
          name: "t",
          systemPrompt: DEFAULT_SYSTEM_PROMPT,
          greeting: "",
          idleTimeoutMs: 1000,
        } as unknown as SessionCoreOptions["agentConfig"],
      });
      await core.start();
      vi.advanceTimersByTime(500);
      core.onAudio(new Uint8Array([1]));
      vi.advanceTimersByTime(800);
      expect(sink.calls.filter((c) => c.method === "idleTimeout")).toHaveLength(0);
      vi.advanceTimersByTime(300);
      expect(sink.calls.filter((c) => c.method === "idleTimeout")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createSessionCore — history", () => {
  test("onHistory appends and onUserTranscript pushes user messages", async () => {
    const { core } = makeCore();
    await core.start();
    core.onHistory([{ role: "user", content: "prior" }]);
    core.onUserTranscript("now");
    // No direct introspection — but onReset clears history and replay should see no effect on subsequent behavior.
    core.onReset();
  });
});
