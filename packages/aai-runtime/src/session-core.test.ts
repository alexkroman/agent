import type { Message } from "@alexkroman1/aai";
import type { ExecuteTool } from "@alexkroman1/aai/host-internal";
import type { ClientSink, SessionEvent } from "@alexkroman1/aai/protocol";
import { describe, expect, test, vi } from "vitest";
import { makeAgentConfig, makeCore, makeSink } from "./_session-core-harness.ts";
import { flush, makeEmitter, makeLogger } from "./_test-utils.ts";
import { createSessionCore, type SessionCore } from "./session-core.ts";
import type { Transport } from "./transports/types.ts";

describe("createSessionCore — lifecycle", () => {
  test("start/stop calls transport", async () => {
    const { core, transport } = makeCore();
    await core.start();
    expect(transport.start).toHaveBeenCalledTimes(1);
    await core.stop();
    expect(transport.stop).toHaveBeenCalledTimes(1);
  });
  test("stop is idempotent", async () => {
    const { core, transport } = makeCore();
    await core.start();
    await core.stop();
    await core.stop();
    expect(transport.stop).toHaveBeenCalledTimes(1);
  });
  test("transport events during stop()'s drain cannot start post-teardown tool work", async () => {
    // stop() aborts the current reply and then awaits transport.stop() — an
    // async drain during which the transport can still dispatch trailing
    // events. A reply.started + tool.call pair used to mint a fresh,
    // un-aborted controller and run the tool after teardown.
    const executeTool = vi.fn(async () => "ok");
    const stopGate = Promise.withResolvers<void>();
    const sink = makeSink();
    const transport: Transport = {
      start: async () => undefined,
      stop: () => stopGate.promise,
      sendUserAudio: vi.fn(),
      sendToolResult: vi.fn(),
      cancelReply: vi.fn(),
    };
    const core = createSessionCore({
      id: "s-test",
      agent: "test-agent",
      client: sink.sink,
      emitter: makeEmitter(sink.sink, { sessionId: "s-test" }).emitter,
      agentConfig: makeAgentConfig(),
      executeTool,
      transport,
    });
    await core.start();
    const stopping = core.stop();
    // Trailing transport events arrive mid-drain.
    core.onReplyStarted("late-reply");
    core.report({ type: "tool.called", toolCallId: "late-call", toolName: "lookup", args: {} });
    core.onAudioChunk(new Uint8Array([1]));
    stopGate.resolve();
    await stopping;
    expect(executeTool).not.toHaveBeenCalled();
    expect(sink.audioChunks).toHaveLength(0);
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
      expect(sink.events.some((e) => e.type === "session.timed-out")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createSessionCore — announce", () => {
  test("hands the instruction to the transport's injected turn", () => {
    const { core, transport } = makeCore();
    const injectTurn = vi.fn();
    (transport as { injectTurn?: (text: string) => void }).injectTurn = injectTurn;

    expect(core.announce("The research you started has finished.")).toBe(true);
    expect(injectTurn).toHaveBeenCalledWith("The research you started has finished.");
  });

  test("reports FALSE for a transport with no such verb", () => {
    // S2S: the service dispatches replies from its own session config and
    // there is nothing to inject. The caller is a run completing in the
    // background, so this has to be an answer rather than a throw.
    const { core, transport } = makeCore();
    expect(transport.injectTurn).toBeUndefined();
    expect(core.announce("finished")).toBe(false);
  });

  test("reports false once the session has stopped", async () => {
    const { core, transport } = makeCore();
    const injectTurn = vi.fn();
    (transport as { injectTurn?: (text: string) => void }).injectTurn = injectTurn;
    await core.stop();

    expect(core.announce("finished")).toBe(false);
    expect(injectTurn).not.toHaveBeenCalled();
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
    core.command({ type: "cancel" });
    expect(transport.cancelReply).toHaveBeenCalledOnce();
    expect(sink.events.some((e) => e.type === "reply.cancelled")).toBe(true);
  });
  test("onCancel aborts an in-flight tool's signal", async () => {
    // A user cancel must stop the tool's actual work — without the abort the
    // tool keeps running (network calls, db writes) into a turn the client
    // already displays as cancelled.
    let seenSignal: AbortSignal | undefined;
    const executeTool: ExecuteTool = async (_n, _a, _s, _m, callOpts) => {
      seenSignal = callOpts?.signal;
      return "ok";
    };
    const { core } = makeCore({ executeTool });
    await core.start();
    core.onReplyStarted("r1");
    core.report({ type: "tool.called", toolCallId: "c1", toolName: "lookup", args: {} });
    expect(seenSignal?.aborted).toBe(false);
    core.command({ type: "cancel" });
    expect(seenSignal?.aborted).toBe(true);
    await flush();
  });
  test("onCancel keeps the reply so aborted tool results still flush to the provider", async () => {
    // S2S has no cancel RPC: the provider is still awaiting tool.result for
    // the calls it issued, so the (error) results must go out on reply.done
    // or the provider-side turn stalls.
    const gate = Promise.withResolvers<string>();
    const executeTool: ExecuteTool = () => gate.promise;
    const { core, transport } = makeCore({ executeTool });
    await core.start();
    core.onReplyStarted("r1");
    core.report({ type: "tool.called", toolCallId: "c1", toolName: "lookup", args: {} });
    core.command({ type: "cancel" });
    gate.resolve("late result");
    core.report({ type: "reply.completed" });
    await vi.waitFor(() => {
      expect(transport.sendToolResult).toHaveBeenCalledWith("c1", "late result");
    });
  });
  test("onReset emits session.reset", async () => {
    const { core, sink } = makeCore();
    await core.start();
    core.command({ type: "reset" });
    expect(sink.events.some((e) => e.type === "session.reset")).toBe(true);
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
    core.report({ type: "user-transcript.committed", text: "hello" });
    expect(sink.events.some((e) => e.type === "user-transcript.committed")).toBe(true);
  });
});

describe("createSessionCore — reply dedup", () => {
  test("first reply.done emits reply.completed + audio.completed", async () => {
    const { core, sink } = makeCore();
    await core.start();
    core.onReplyStarted("r1");
    core.report({ type: "reply.completed" });
    expect(sink.events.some((e) => e.type === "reply.completed")).toBe(true);
    // `audio.completed` is an EVENT now, not a `playAudioDone()` on the sink —
    // which is what put it in the retained stream. The sink is what keeps it
    // behind held audio, by type.
    expect(sink.events.some((e) => e.type === "audio.completed")).toBe(true);
  });
  test("duplicate reply_done is dropped", async () => {
    const { core, sink } = makeCore();
    await core.start();
    core.onReplyStarted("r1");
    core.report({ type: "reply.completed" });
    core.report({ type: "reply.completed" });
    const dones = sink.events.filter((e) => e.type === "reply.completed");
    expect(dones).toHaveLength(1);
  });
  test("onCancelled clears currentReplyId so subsequent replyDone is dropped", async () => {
    const { core, sink } = makeCore();
    await core.start();
    core.onReplyStarted("r1");
    core.report({ type: "reply.cancelled" });
    core.report({ type: "reply.completed" });
    expect(sink.events.filter((e) => e.type === "reply.completed")).toHaveLength(0);
  });
});

describe("createSessionCore — tool call pending results", () => {
  test("tool_call executes, tool_call_done fires, reply_done forwards results to transport", async () => {
    const executeTool = vi.fn(async () => "tool-output");
    const { core, sink, transport } = makeCore({ executeTool });
    await core.start();
    core.onReplyStarted("r1");
    core.report({ type: "tool.called", toolCallId: "cid", toolName: "my_tool", args: {} });
    await flush();
    core.report({ type: "reply.completed" });
    await vi.waitFor(() =>
      expect(transport.sendToolResult).toHaveBeenCalledWith("cid", "tool-output"),
    );
    expect(sink.events.some((e) => e.type === "tool.completed")).toBe(true);
  });

  test("a barged-in reply's late tool result is not forwarded to the next reply", async () => {
    const slow = Promise.withResolvers<string>();
    const executeTool = vi.fn(() => slow.promise);
    const { core, transport } = makeCore({ executeTool });
    await core.start();

    // Reply r1 issues a slow tool and completes its turn (done is queued
    // behind the pending tool).
    core.onReplyStarted("r1");
    core.report({ type: "tool.called", toolCallId: "cid1", toolName: "slow", args: {} });
    core.report({ type: "reply.completed" });

    // Barge-in cancels r1; a new reply r2 starts.
    core.report({ type: "reply.cancelled" });
    core.onReplyStarted("r2");

    // r1's tool finally resolves — its result belongs to the cancelled reply
    // and must not be routed into r2.
    slow.resolve("slow-output");
    await flush();
    core.report({ type: "reply.completed" });
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
    core.report({ type: "user-transcript.committed", text: "first" });
    core.onReplyStarted("r1");
    core.report({ type: "tool.called", toolCallId: "cid", toolName: "t", args: {} });
    // Arrives while the tool is (conceptually) still running — must not
    // appear in the view the tool captured.
    core.report({ type: "user-transcript.committed", text: "second" });
    await flush();
    expect(captured?.map((m) => m.content)).toEqual(["first"]);
  });

  test("barge-in (onCancelled) aborts the in-flight tool's signal", async () => {
    const { executeTool, signals } = abortSettledTool();
    const { core } = makeCore({ executeTool });
    await core.start();
    core.onReplyStarted("r1");
    core.report({ type: "tool.called", toolCallId: "cid", toolName: "slow", args: {} });
    expect(signals[0]?.aborted).toBe(false);
    core.report({ type: "reply.cancelled" });
    expect(signals[0]?.aborted).toBe(true);
  });

  test("a new reply.started aborts the previous reply's in-flight tools", async () => {
    const { executeTool, signals } = abortSettledTool();
    const { core } = makeCore({ executeTool });
    await core.start();
    core.onReplyStarted("r1");
    core.report({ type: "tool.called", toolCallId: "cid", toolName: "slow", args: {} });
    core.onReplyStarted("r2");
    expect(signals[0]?.aborted).toBe(true);
  });

  test("stop() aborts in-flight tools so the drain settles promptly", async () => {
    const { executeTool, signals } = abortSettledTool();
    const { core, transport } = makeCore({ executeTool });
    await core.start();
    core.onReplyStarted("r1");
    core.report({ type: "tool.called", toolCallId: "cid", toolName: "slow", args: {} });
    // Resolves only because stop() aborts the reply's signal — otherwise this
    // await would hang on the never-resolving tool.
    await core.stop();
    expect(signals[0]?.aborted).toBe(true);
    expect(transport.stop).toHaveBeenCalledTimes(1);
  });
});

describe("createSessionCore — duplicate reply.done in multi-hop turns", () => {
  test("duplicate reply.done after a tool-result flush does not end the turn early", async () => {
    const executeTool = vi.fn(async () => "out");
    const { core, sink, transport } = makeCore({ executeTool });
    await core.start();
    core.onReplyStarted("r1");
    core.report({ type: "tool.called", toolCallId: "cid", toolName: "t", args: {} });
    await flush();
    core.report({ type: "reply.completed" }); // flushes the tool result to the transport
    await vi.waitFor(() => expect(transport.sendToolResult).toHaveBeenCalledWith("cid", "out"));

    core.report({ type: "reply.completed" }); // duplicated frame from the service
    await flush();
    await flush();
    await flush();
    expect(sink.events.filter((e) => e.type === "reply.completed")).toHaveLength(0);

    // The real continuation arrives and ends the turn exactly once.
    core.report({ type: "agent-transcript.committed", text: "answer" });
    core.report({ type: "reply.completed" });
    await vi.waitFor(() =>
      expect(sink.events.filter((e) => e.type === "reply.completed")).toHaveLength(1),
    );
  });

  test("multi-hop: each reply.done flushes that hop's results; the final one ends the turn", async () => {
    const executeTool = vi.fn(async () => "out");
    const { core, sink, transport } = makeCore({ executeTool });
    await core.start();
    core.onReplyStarted("r1");

    core.report({ type: "tool.called", toolCallId: "c1", toolName: "t", args: {} });
    await flush();
    core.report({ type: "reply.completed" });
    await vi.waitFor(() => expect(transport.sendToolResult).toHaveBeenCalledWith("c1", "out"));
    expect(sink.events.filter((e) => e.type === "reply.completed")).toHaveLength(0);

    core.report({ type: "tool.called", toolCallId: "c2", toolName: "t", args: {} }); // continuation hop
    await flush();
    core.report({ type: "reply.completed" });
    await vi.waitFor(() => expect(transport.sendToolResult).toHaveBeenCalledWith("c2", "out"));
    expect(sink.events.filter((e) => e.type === "reply.completed")).toHaveLength(0);

    core.report({ type: "agent-transcript.committed", text: "final answer" });
    core.report({ type: "reply.completed" });
    await vi.waitFor(() =>
      expect(sink.events.filter((e) => e.type === "reply.completed")).toHaveLength(1),
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
      expect(sink.events.filter((e) => e.type === "session.timed-out")).toHaveLength(0);
      vi.advanceTimersByTime(1001);
      expect(sink.events.filter((e) => e.type === "session.timed-out")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
  // Idle means "nobody is talking", not "the client stopped sending bytes".
  // The browser mic streams continuously (barge-in needs it open), so while
  // raw frames re-armed the timer a tab left open on a silent room pinned the
  // session — and on the platform its guest, whose own idle self-exit needs
  // the session count to reach zero.
  test("inbound audio frames do NOT reset the idle timer", async () => {
    vi.useFakeTimers();
    try {
      const { core, sink } = makeCore({
        agentConfig: makeAgentConfig({ name: "t", idleTimeoutMs: 1000 }),
      });
      await core.start();
      // A continuously-streaming silent mic: frames the whole way through.
      for (let t = 0; t < 1100; t += 20) {
        core.onAudio(new Uint8Array(640));
        vi.advanceTimersByTime(20);
      }
      expect(sink.events.filter((e) => e.type === "session.timed-out")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // The transport is the one that can tell speech from silence, so it owns
  // the signal — and a client cannot fake it: to make STT report speech it
  // has to send audio that really contains some.
  test.each([
    ["speech the transport detected", (c: SessionCore) => c.report({ type: "speech.started" })],
    [
      "an interim user transcript",
      (c: SessionCore) => c.report({ type: "user-transcript.updated", text: "hel" }),
    ],
    [
      "a committed user turn",
      (c: SessionCore) => c.report({ type: "user-transcript.committed", text: "hello" }),
    ],
    ["the agent replying", (c: SessionCore) => c.onReplyStarted("r1")],
    ["agent audio", (c: SessionCore) => c.onAudioChunk(new Uint8Array([1]))],
    [
      "a tool call",
      (c: SessionCore) =>
        c.report({ type: "tool.called", toolCallId: "c1", toolName: "t", args: {} }),
    ],
  ])("%s resets the idle timer", async (_label, act) => {
    vi.useFakeTimers();
    try {
      const { core, sink } = makeCore({
        agentConfig: makeAgentConfig({ name: "t", idleTimeoutMs: 1000 }),
      });
      await core.start();
      vi.advanceTimersByTime(800);
      act(core);
      vi.advanceTimersByTime(800);
      expect(sink.events.filter((e) => e.type === "session.timed-out")).toHaveLength(0);
      vi.advanceTimersByTime(300);
      expect(sink.events.filter((e) => e.type === "session.timed-out")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
  test("closes the client connection after emitting idle_timeout", async () => {
    // The event alone retires nothing: aai-ui routes idle_timeout to its
    // default branch and waits for the close handler to transition the
    // session. Without this the socket stays open, holding the session, its
    // provider sockets, and (on the platform) a Modal input slot.
    vi.useFakeTimers();
    try {
      const { core, sink } = makeCore({
        agentConfig: makeAgentConfig({ name: "t", idleTimeoutMs: 1000 }),
      });
      await core.start();
      vi.advanceTimersByTime(1001);
      expect(sink.events.filter((e) => e.type === "session.timed-out")).toHaveLength(1);
      expect(sink.closeReasons).toEqual(["idle timeout"]);
    } finally {
      vi.useRealTimers();
    }
  });
  test("emits session.timed-out before closing, so the client learns why", async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      const sink = makeSink();
      const tracking: ClientSink = {
        ...sink.sink,
        event: (e: SessionEvent) => {
          order.push(`event:${e.type}`);
          sink.sink.event(e);
        },
        close: (reason?: string) => {
          order.push("close");
          sink.sink.close?.(reason);
        },
      };
      const { core } = makeCore({
        client: tracking,
        agentConfig: makeAgentConfig({ name: "t", idleTimeoutMs: 1000 }),
      });
      await core.start();
      vi.advanceTimersByTime(1001);
      expect(order).toEqual(["event:session.timed-out", "close"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createSessionCore — the handshake", () => {
  // `wireSessionSocket` decides WHEN to announce (zero RTT, before start); the
  // frame's contents are this module's, so they are asserted here. It used to be
  // a JSON literal written straight to the socket by the handler, which is what
  // kept the handshake out of the event stream.
  test("configure emits session.configured with the negotiated rates and the session id", () => {
    const { core, sink } = makeCore();

    core.configure({ audioFormat: "pcm16", sampleRate: 16_000, ttsSampleRate: 24_000 });

    expect(sink.events).toContainEqual(
      expect.objectContaining({
        type: "session.configured",
        audioFormat: "pcm16",
        sampleRate: 16_000,
        ttsSampleRate: 24_000,
        // What a client reconnects with (`?sessionId=`) and reads the stream by.
        sessionId: "s-test",
      }),
    );
  });

  test("the handshake is RECORDED in the session's stream, like any other event", async () => {
    const { core, stream } = makeCore();

    core.configure({ audioFormat: "pcm16", sampleRate: 16_000, ttsSampleRate: 24_000 });

    const page = await stream.read("s-test", 0);
    expect(page.events.map((e) => e.type)).toEqual(["session.configured"]);
    expect(page.tail).toBe(1);
  });
});

describe("createSessionCore — error logging", () => {
  // A provider ending a session (STT session cap, idle cutoff) used to reach the
  // client only, so the server's log showed the close and nothing about why.
  test("a fatal error is logged server-side, not just emitted", () => {
    const logger = makeLogger();
    const { core, sink } = makeCore({ logger });

    core.report({
      type: "error.reported",
      code: "stt",
      message: "socket closed 1000",
      fatal: true,
    });

    expect(logger.warn).toHaveBeenCalledWith("session error (fatal)", {
      sid: "s-test",
      code: "stt",
      message: "socket closed 1000",
    });
    // `objectContaining`, because every event carries an envelope now and this
    // spec is about the error, not the id it was stamped with.
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        type: "error.reported",
        code: "stt",
        message: "socket closed 1000",
      }),
    );
  });

  test("a non-fatal error stays at debug level", () => {
    const logger = makeLogger();
    const { core } = makeCore({ logger });

    core.report({ type: "error.reported", code: "internal", message: "recoverable", fatal: false });

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith("session error", {
      sid: "s-test",
      code: "internal",
      message: "recoverable",
    });
  });
});

/**
 * What `ws-handler.ts` reads before it claims a session is ready. Production
 * logged `session error (fatal)` for a missing TTS key and `Session ready` 400ms
 * later, on a session that could never speak.
 */
describe("createSessionCore — faultCode", () => {
  test("is undefined on a session that has reported nothing", () => {
    const { core } = makeCore({});
    expect(core.faultCode).toBeUndefined();
  });

  test("carries the code of a fatal error", () => {
    const { core } = makeCore({});
    core.report({ type: "error.reported", code: "tts", message: "missing API key", fatal: true });
    expect(core.faultCode).toBe("tts");
  });

  test("a non-fatal error leaves it undefined", () => {
    const { core } = makeCore({});
    core.report({ type: "error.reported", code: "internal", message: "recoverable", fatal: false });
    expect(core.faultCode).toBeUndefined();
  });

  /** The FIRST fatal is the cause; later ones are usually downstream of it. */
  test("keeps the first fatal code when several are reported", () => {
    const { core } = makeCore({});
    core.report({ type: "error.reported", code: "tts", message: "missing API key", fatal: true });
    core.report({ type: "error.reported", code: "stt", message: "socket closed", fatal: true });
    expect(core.faultCode).toBe("tts");
  });
});
