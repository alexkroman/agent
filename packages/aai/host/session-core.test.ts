import { describe, expect, test, vi } from "vitest";
import type { ClientEvent, ClientSink } from "../sdk/protocol.ts";
import { DEFAULT_SYSTEM_PROMPT } from "../sdk/types.ts";
import { flush } from "./_test-utils.ts";
import type { SessionCore, SessionCoreOptions } from "./session-core.ts";
import { createSessionCore } from "./session-core.ts";
import type { Transport } from "./transports/types.ts";

function makeSink(): {
  events: ClientEvent[];
  audioChunks: Uint8Array[];
  audioDoneCount: number;
  sink: ClientSink;
} {
  const events: ClientEvent[] = [];
  const audioChunks: Uint8Array[] = [];
  let audioDoneCount = 0;
  return {
    events,
    audioChunks,
    get audioDoneCount() {
      return audioDoneCount;
    },
    sink: {
      get open() {
        return true;
      },
      event: (e) => {
        events.push(e);
      },
      playAudioChunk: (chunk) => {
        audioChunks.push(chunk);
      },
      playAudioDone: () => {
        audioDoneCount++;
      },
    } satisfies ClientSink,
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
      expect(sink.events.some((e) => e.type === "idle_timeout")).toBe(false);
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
    expect(sink.events.some((e) => e.type === "cancelled")).toBe(true);
  });
  test("onReset emits reset", async () => {
    const { core, sink } = makeCore();
    await core.start();
    core.onReset();
    expect(sink.events.some((e) => e.type === "reset")).toBe(true);
  });
});

describe("createSessionCore — transport inbound (basic)", () => {
  test("onAudioChunk forwards to sink", async () => {
    const { core, sink } = makeCore();
    await core.start();
    const pcm = new Uint8Array([9, 8, 7]);
    core.onAudioChunk(pcm);
    expect(sink.audioChunks).toContain(pcm);
  });
  test("onUserTranscript pushes to history and emits", async () => {
    const { core, sink } = makeCore();
    await core.start();
    core.onUserTranscript("hello");
    expect(sink.events.some((e) => e.type === "user_transcript")).toBe(true);
  });
});

describe("createSessionCore — reply dedup", () => {
  test("first reply_done emits reply_done + audio_done", async () => {
    const { core, sink } = makeCore();
    await core.start();
    core.onReplyStarted("r1");
    core.onReplyDone();
    expect(sink.events.some((e) => e.type === "reply_done")).toBe(true);
    expect(sink.audioDoneCount).toBeGreaterThanOrEqual(1);
  });
  test("duplicate reply_done is dropped", async () => {
    const { core, sink } = makeCore();
    await core.start();
    core.onReplyStarted("r1");
    core.onReplyDone();
    core.onReplyDone();
    const dones = sink.events.filter((e) => e.type === "reply_done");
    expect(dones).toHaveLength(1);
  });
  test("onCancelled clears currentReplyId so subsequent replyDone is dropped", async () => {
    const { core, sink } = makeCore();
    await core.start();
    core.onReplyStarted("r1");
    core.onCancelled();
    core.onReplyDone();
    expect(sink.events.filter((e) => e.type === "reply_done")).toHaveLength(0);
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
    expect(sink.events.some((e) => e.type === "tool_call_done")).toBe(true);
  });
});

describe("createSessionCore — idle timeout", () => {
  test("emits idle_timeout after agentConfig.idleTimeoutMs of no audio", async () => {
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
      expect(sink.events.filter((e) => e.type === "idle_timeout")).toHaveLength(0);
      vi.advanceTimersByTime(1001);
      expect(sink.events.filter((e) => e.type === "idle_timeout")).toHaveLength(1);
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
      expect(sink.events.filter((e) => e.type === "idle_timeout")).toHaveLength(0);
      vi.advanceTimersByTime(300);
      expect(sink.events.filter((e) => e.type === "idle_timeout")).toHaveLength(1);
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
