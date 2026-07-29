import { describe, expect, test, vi } from "vitest";
import type { AgentConfig, ExecuteTool } from "../sdk/_internal-types.ts";
import type { ClientEvent, ClientSink } from "../sdk/protocol.ts";
import { DEFAULT_SYSTEM_PROMPT, type Message } from "../sdk/types.ts";
import { flush } from "./_test-utils.ts";
import type { SessionCore, SessionCoreOptions } from "./session-core.ts";
import { createSessionCore } from "./session-core.ts";
import type { Transport } from "./transports/types.ts";

function makeSink(): {
  events: ClientEvent[];
  audioChunks: Uint8Array[];
  readonly audioDoneCount: number;
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
      open: true,
      event: (e) => {
        events.push(e);
      },
      playAudioChunk: (chunk) => {
        audioChunks.push(chunk);
      },
      playAudioDone: () => {
        audioDoneCount++;
      },
    },
  };
}

function makeTransport(): Transport & { readonly starts: number; readonly stops: number } {
  let starts = 0;
  let stops = 0;
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

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { name: "test", systemPrompt: DEFAULT_SYSTEM_PROMPT, greeting: "", ...overrides };
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
    agentConfig: makeAgentConfig(),
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
        agentConfig: makeAgentConfig({ idleTimeoutMs: 1000 }),
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
    await flush();
    core.onReplyDone();
    await vi.waitFor(() =>
      expect(transport.sendToolResult).toHaveBeenCalledWith("cid", "tool-output"),
    );
    expect(sink.events.some((e) => e.type === "tool_call_done")).toBe(true);
  });

  test("a barged-in reply's late tool result is not forwarded to the next reply", async () => {
    let resolveSlow: (v: string) => void = () => undefined;
    const executeTool = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolveSlow = r;
        }),
    );
    const { core, transport } = makeCore({ executeTool });
    await core.start();

    // Reply r1 issues a slow tool and completes its turn (done is queued
    // behind the pending tool).
    core.onReplyStarted("r1");
    core.onToolCall("cid1", "slow", {});
    core.onReplyDone();

    // Barge-in cancels r1; a new reply r2 starts.
    core.onCancelled();
    core.onReplyStarted("r2");

    // r1's tool finally resolves — its result belongs to the cancelled reply
    // and must not be routed into r2.
    resolveSlow("slow-output");
    await flush();
    core.onReplyDone();
    await flush();

    expect(transport.sendToolResult).not.toHaveBeenCalledWith("cid1", "slow-output");
  });
});

describe("createSessionCore — tool concurrency", () => {
  /** ExecuteTool mock that resolves only when its abort signal fires. */
  function abortSettledTool(): {
    executeTool: ExecuteTool;
    signals: AbortSignal[];
  } {
    const signals: AbortSignal[] = [];
    const executeTool: ExecuteTool = (_name, _args, _sid, _messages, callOpts) => {
      const signal = callOpts?.signal;
      if (!signal) throw new Error("expected a signal");
      signals.push(signal);
      return new Promise<string>((resolve) => {
        signal.addEventListener("abort", () => resolve('{"error":"cancelled"}'), { once: true });
      });
    };
    return { executeTool, signals };
  }

  test("tools receive a history snapshot, not the live array", async () => {
    let captured: readonly Message[] | undefined;
    const executeTool: ExecuteTool = async (_name, _args, _sid, messages) => {
      captured = messages;
      return "ok";
    };
    const { core } = makeCore({ executeTool });
    await core.start();
    core.onUserTranscript("first");
    core.onReplyStarted("r1");
    core.onToolCall("cid", "t", {});
    // Arrives while the tool is (conceptually) still running — must not
    // appear in the view the tool captured.
    core.onUserTranscript("second");
    await flush();
    expect(captured?.map((m) => m.content)).toEqual(["first"]);
  });

  test("barge-in (onCancelled) aborts the in-flight tool's signal", async () => {
    const { executeTool, signals } = abortSettledTool();
    const { core } = makeCore({ executeTool });
    await core.start();
    core.onReplyStarted("r1");
    core.onToolCall("cid", "slow", {});
    expect(signals[0]?.aborted).toBe(false);
    core.onCancelled();
    expect(signals[0]?.aborted).toBe(true);
  });

  test("a new reply.started aborts the previous reply's in-flight tools", async () => {
    const { executeTool, signals } = abortSettledTool();
    const { core } = makeCore({ executeTool });
    await core.start();
    core.onReplyStarted("r1");
    core.onToolCall("cid", "slow", {});
    core.onReplyStarted("r2");
    expect(signals[0]?.aborted).toBe(true);
  });

  test("stop() aborts in-flight tools so the drain settles promptly", async () => {
    const { executeTool, signals } = abortSettledTool();
    const { core, transport } = makeCore({ executeTool });
    await core.start();
    core.onReplyStarted("r1");
    core.onToolCall("cid", "slow", {});
    // Resolves only because stop() aborts the reply's signal — otherwise this
    // await would hang on the never-resolving tool.
    await core.stop();
    expect(signals[0]?.aborted).toBe(true);
    expect(transport.stops).toBe(1);
  });
});

describe("createSessionCore — duplicate reply.done in multi-hop turns", () => {
  test("duplicate reply.done after a tool-result flush does not end the turn early", async () => {
    const executeTool = vi.fn(async () => "out");
    const { core, sink, transport } = makeCore({ executeTool });
    await core.start();
    core.onReplyStarted("r1");
    core.onToolCall("cid", "t", {});
    await flush();
    core.onReplyDone(); // flushes the tool result to the transport
    await vi.waitFor(() => expect(transport.sendToolResult).toHaveBeenCalledWith("cid", "out"));

    core.onReplyDone(); // duplicated frame from the service
    await flush();
    await flush();
    await flush();
    expect(sink.events.filter((e) => e.type === "reply_done")).toHaveLength(0);

    // The real continuation arrives and ends the turn exactly once.
    core.onAgentTranscript("answer", false);
    core.onReplyDone();
    await vi.waitFor(() =>
      expect(sink.events.filter((e) => e.type === "reply_done")).toHaveLength(1),
    );
  });

  test("multi-hop: each reply.done flushes that hop's results; the final one ends the turn", async () => {
    const executeTool = vi.fn(async () => "out");
    const { core, sink, transport } = makeCore({ executeTool });
    await core.start();
    core.onReplyStarted("r1");

    core.onToolCall("c1", "t", {});
    await flush();
    core.onReplyDone();
    await vi.waitFor(() => expect(transport.sendToolResult).toHaveBeenCalledWith("c1", "out"));
    expect(sink.events.filter((e) => e.type === "reply_done")).toHaveLength(0);

    core.onToolCall("c2", "t", {}); // continuation hop
    await flush();
    core.onReplyDone();
    await vi.waitFor(() => expect(transport.sendToolResult).toHaveBeenCalledWith("c2", "out"));
    expect(sink.events.filter((e) => e.type === "reply_done")).toHaveLength(0);

    core.onAgentTranscript("final answer", false);
    core.onReplyDone();
    await vi.waitFor(() =>
      expect(sink.events.filter((e) => e.type === "reply_done")).toHaveLength(1),
    );
  });
});

describe("createSessionCore — idle timeout", () => {
  test("emits idle_timeout after agentConfig.idleTimeoutMs of no audio", async () => {
    vi.useFakeTimers();
    try {
      const { core, sink } = makeCore({
        agentConfig: makeAgentConfig({ name: "t", idleTimeoutMs: 1000 }),
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
        agentConfig: makeAgentConfig({ name: "t", idleTimeoutMs: 1000 }),
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
    core.onReset();
  });
});

describe("transcribe_file upload buffering", () => {
  test("buffers binary frames between start and end, delivering one assembled clip", () => {
    const { core, transport } = makeCore();
    const transcribeFile = vi.fn();
    (transport as { transcribeFile?: Transport["transcribeFile"] }).transcribeFile = transcribeFile;

    core.onTranscribeFileStart(16_000, 6);
    core.onAudio(new Uint8Array([1, 2, 3]));
    core.onAudio(new Uint8Array([4, 5, 6]));
    // Mid-upload frames never reach the realtime audio path.
    expect(transport.sendUserAudio).not.toHaveBeenCalled();

    core.onTranscribeFileEnd();
    expect(transcribeFile).toHaveBeenCalledOnce();
    const [pcm, sampleRate] = transcribeFile.mock.calls[0] as [Uint8Array, number];
    expect([...pcm]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(sampleRate).toBe(16_000);

    // After the upload, live audio streams normally again.
    core.onAudio(new Uint8Array([9]));
    expect(transport.sendUserAudio).toHaveBeenCalledOnce();
  });

  test("falls back to replaying through sendUserAudio when the transport has no one-shot path", async () => {
    const { core, transport } = makeCore();
    core.onTranscribeFileStart(16_000, 4);
    core.onAudio(new Uint8Array([1, 2, 3, 4]));
    core.onTranscribeFileEnd();
    // The replay is paced across event-loop ticks (so the provider socket
    // drains and its backpressure gate never drops a chunk), so wait for it.
    const sendUserAudio = transport.sendUserAudio as ReturnType<typeof vi.fn>;
    await vi.waitFor(() => {
      const total = sendUserAudio.mock.calls.reduce((n, c) => n + (c[0] as Uint8Array).length, 0);
      expect(total).toBe(4 + 16_000 * 2);
    });
    const replayed = sendUserAudio.mock.calls.flatMap((c) => [...(c[0] as Uint8Array)]);
    // The clip itself, then one second of endpointing silence at 16 kHz PCM16.
    expect(replayed.slice(0, 4)).toEqual([1, 2, 3, 4]);
    expect(replayed.length).toBe(4 + 16_000 * 2);
    expect(replayed.slice(4).every((b) => b === 0)).toBe(true);
  });

  test("bytes past the declared byteLength are dropped", () => {
    const { core, transport } = makeCore();
    const transcribeFile = vi.fn();
    (transport as { transcribeFile?: Transport["transcribeFile"] }).transcribeFile = transcribeFile;
    core.onTranscribeFileStart(16_000, 2);
    core.onAudio(new Uint8Array([1, 2]));
    core.onAudio(new Uint8Array([3, 4])); // over-declared — dropped
    core.onTranscribeFileEnd();
    const [pcm] = transcribeFile.mock.calls[0] as [Uint8Array];
    expect([...pcm]).toEqual([1, 2]);
  });

  test("a fully-received upload finalizes without waiting for the end frame", () => {
    const { core, transport } = makeCore();
    const transcribeFile = vi.fn();
    (transport as { transcribeFile?: Transport["transcribeFile"] }).transcribeFile = transcribeFile;
    core.onTranscribeFileStart(16_000, 4);
    core.onAudio(new Uint8Array([1, 2, 3, 4]));
    // Declared byteLength fulfilled — the clip is handed off immediately, so a
    // dropped end frame can't leave the session absorbing mic audio forever.
    expect(transcribeFile).toHaveBeenCalledOnce();
    // The (now redundant) end frame is a no-op, not a second transcription.
    core.onTranscribeFileEnd();
    expect(transcribeFile).toHaveBeenCalledOnce();
    // Live audio flows again.
    core.onAudio(new Uint8Array([9]));
    expect(transport.sendUserAudio).toHaveBeenCalledOnce();
  });

  test("an end without a start (or an empty upload) is a no-op", () => {
    const { core, transport } = makeCore();
    core.onTranscribeFileEnd();
    core.onTranscribeFileStart(16_000, 4);
    core.onTranscribeFileEnd();
    expect(transport.sendUserAudio).not.toHaveBeenCalled();
  });

  test("an invalid byteLength declaration is rejected (no allocation, no upload)", () => {
    const { core, transport } = makeCore();
    const transcribeFile = vi.fn();
    (transport as { transcribeFile?: Transport["transcribeFile"] }).transcribeFile = transcribeFile;
    // Over the one-shot cap, non-integer, and non-positive: all ignored —
    // the client-supplied length sizes the upload buffer allocation.
    core.onTranscribeFileStart(16_000, 13 * 1024 * 1024);
    core.onTranscribeFileStart(16_000, 1.5);
    core.onTranscribeFileStart(16_000, 0);
    // No upload in flight → audio streams straight through as mic audio.
    core.onAudio(new Uint8Array([1, 2]));
    expect(transport.sendUserAudio).toHaveBeenCalledOnce();
    core.onTranscribeFileEnd();
    expect(transcribeFile).not.toHaveBeenCalled();
  });

  test("reset discards a half-finished upload", () => {
    const { core, transport } = makeCore();
    core.onTranscribeFileStart(16_000, 4);
    core.onAudio(new Uint8Array([1, 2]));
    core.onReset();
    core.onTranscribeFileEnd();
    expect(transport.sendUserAudio).not.toHaveBeenCalled();
  });
});

describe("createSessionCore — error logging", () => {
  // A provider ending a session (STT session cap, idle cutoff) used to reach the
  // client only, so the server's log showed the close and nothing about why.
  test("a fatal error is logged server-side, not just emitted", () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const { core, sink } = makeCore({ logger });

    core.onError("stt", "socket closed 1000");

    expect(logger.warn).toHaveBeenCalledWith("session error (fatal)", {
      sid: "s-test",
      code: "stt",
      message: "socket closed 1000",
    });
    expect(sink.events).toContainEqual({
      type: "error",
      code: "stt",
      message: "socket closed 1000",
    });
  });

  test("a non-fatal error stays at debug level", () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const { core } = makeCore({ logger });

    core.onError("internal", "recoverable", { fatal: false });

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith("session error", {
      sid: "s-test",
      code: "internal",
      message: "recoverable",
    });
  });
});
