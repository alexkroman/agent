// Copyright 2026 the AAI authors. MIT license.
// connectS2s server-event dispatch specs: speech, transcript, reply, tool,
// and audio events. Connection/handle API and error/close specs live in
// s2s.test.ts; shared helpers in _s2s-test-utils.ts.

import { describe, expect, test, vi } from "vitest";
import {
  createTestS2s,
  emitMessage,
  makeMockCallbacks,
  s2sConfig,
  setupHandle,
} from "./_s2s-test-utils.ts";
import { connectS2s } from "./s2s.ts";

describe("connectS2s event dispatch", () => {
  test("session.ready dispatches 'onSessionReady' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "session.ready", session_id: "s123" });

    expect(callbacks.onSessionReady).toHaveBeenCalledOnce();
    expect(callbacks.onSessionReady).toHaveBeenCalledWith("s123");
  });

  test("input.speech.started dispatches 'onSpeechStarted' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "input.speech.started" });

    expect(callbacks.onSpeechStarted).toHaveBeenCalledOnce();
  });

  test("input.speech.stopped dispatches 'onSpeechStopped' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    // speech_stopped is only forwarded after a speech_started primes VAD state.
    emitMessage(raw, { type: "input.speech.started" });
    emitMessage(raw, { type: "input.speech.stopped" });

    expect(callbacks.onSpeechStarted).toHaveBeenCalledOnce();
    expect(callbacks.onSpeechStopped).toHaveBeenCalledOnce();
  });

  test("duplicate input.speech.stopped is suppressed", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "input.speech.started" });
    emitMessage(raw, { type: "input.speech.stopped" });
    emitMessage(raw, { type: "input.speech.stopped" });

    expect(callbacks.onSpeechStopped).toHaveBeenCalledOnce();
  });

  test("transcript.user dispatches 'onUserTranscript' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "transcript.user", item_id: "item-1", text: "Hello world" });

    expect(callbacks.onUserTranscript).toHaveBeenCalledOnce();
    expect(callbacks.onUserTranscript).toHaveBeenCalledWith("Hello world");
  });

  test("reply.started dispatches 'onReplyStarted' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "reply.started", reply_id: "r1" });

    expect(callbacks.onReplyStarted).toHaveBeenCalledOnce();
    expect(callbacks.onReplyStarted).toHaveBeenCalledWith("r1");
  });

  test("transcript.agent dispatches 'onAgentTranscript' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, {
      type: "transcript.agent",
      text: "Full response",
      reply_id: "r1",
      item_id: "i1",
      interrupted: false,
    });

    expect(callbacks.onAgentTranscript).toHaveBeenCalledOnce();
    expect(callbacks.onAgentTranscript).toHaveBeenCalledWith("Full response", false);
  });

  test("transcript.agent defaults interrupted to false when missing", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "transcript.agent", text: "response" });

    expect(callbacks.onAgentTranscript).toHaveBeenCalledWith("response", false);
  });

  test("transcript.agent with interrupted:true passes interrupted:true", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, {
      type: "transcript.agent",
      text: "Interrupted response",
      interrupted: true,
    });

    expect(callbacks.onAgentTranscript).toHaveBeenCalledWith("Interrupted response", true);
  });

  test("tool.call dispatches 'onToolCall' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, {
      type: "tool.call",
      call_id: "c1",
      name: "web_search",
      args: { query: "test" },
    });

    expect(callbacks.onToolCall).toHaveBeenCalledOnce();
    expect(callbacks.onToolCall).toHaveBeenCalledWith("c1", "web_search", { query: "test" });
  });

  test("reply.done (non-interrupted) dispatches 'onReplyDone' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "reply.done", status: "completed" });

    expect(callbacks.onReplyDone).toHaveBeenCalledOnce();
    expect(callbacks.onCancelled).not.toHaveBeenCalled();
  });

  test("reply.done with status 'interrupted' dispatches 'onCancelled' callback", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "reply.done", status: "interrupted" });

    expect(callbacks.onCancelled).toHaveBeenCalledOnce();
    expect(callbacks.onReplyDone).not.toHaveBeenCalled();
  });

  test("reply.done arrival is logged with sid and status", async () => {
    const { raw, createWebSocket, logger } = createTestS2s();
    const infoSpy = vi.fn();
    logger.info = infoSpy;
    await connectS2s({
      apiKey: "test-key",
      config: s2sConfig,
      createWebSocket,
      callbacks: makeMockCallbacks(),
      logger,
      sid: "sess-abc",
    });

    emitMessage(raw, { type: "reply.done", status: "completed" });

    const arrivalCall = infoSpy.mock.calls.find((c) => c[0] === "S2S << reply.done");
    expect(arrivalCall).toBeDefined();
    expect(arrivalCall?.[1]).toMatchObject({ sid: "sess-abc", status: "completed" });
  });

  test("reply.audio dispatches 'onAudio' callback with decoded Uint8Array", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    const audioBytes = new Uint8Array([10, 20, 30, 40]);
    const base64 = Buffer.from(audioBytes).toString("base64");

    emitMessage(raw, { type: "reply.audio", data: base64 });

    expect(callbacks.onAudio).toHaveBeenCalledOnce();
    const payload = (callbacks.onAudio as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(payload).toBeInstanceOf(Uint8Array);
    expect(Array.from(payload)).toEqual([10, 20, 30, 40]);
  });

  test("reply.content_part events are silently ignored (no dispatch)", async () => {
    const { raw } = await setupHandle();
    emitMessage(raw, { type: "reply.content_part.started" });
    emitMessage(raw, { type: "reply.content_part.done" });
  });
});

const UNRECOGNISED_PREFIX = "S2S << unrecognised message type: ";

/**
 * Message types the parser rejected, read back out of its warnings. These specs
 * assert a type is absent from this list rather than that nothing was warned at
 * all: `setupHandle`'s logger is the shared `silentLogger` singleton, whose call
 * history accumulates across tests in the file.
 */
function droppedTypes(logger: Awaited<ReturnType<typeof setupHandle>>["logger"]): string[] {
  return logger.warn.mock.calls
    .map((call) => String(call[0]))
    .filter((msg) => msg.startsWith(UNRECOGNISED_PREFIX))
    .map((msg) => msg.slice(UNRECOGNISED_PREFIX.length));
}

// The live service emits both partial-transcript streams; neither was in the
// schema, so each arrived, failed the discriminated union, and was dropped with
// only an "unrecognised message type" warning — the client saw no live captions
// at all in S2S mode while pipeline mode had them.
describe("connectS2s partial transcripts", () => {
  test("transcript.user.delta dispatches 'onUserTranscriptPartial'", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "transcript.user.delta", item_id: "item-1", text: "what's the" });

    expect(callbacks.onUserTranscriptPartial).toHaveBeenCalledOnce();
    expect(callbacks.onUserTranscriptPartial).toHaveBeenCalledWith("what's the");
  });

  test("transcript.user.delta is not logged as an unrecognised message type", async () => {
    const { raw, logger } = await setupHandle();

    emitMessage(raw, { type: "transcript.user.delta", item_id: "item-1", text: "hey" });

    expect(droppedTypes(logger)).not.toContain("transcript.user.delta");
  });

  // `text` is the full transcript so far, not an increment: the docs say each
  // delta supersedes the previous one for that item_id. Passing it straight
  // through matches `onUserTranscriptPartial`'s replace-not-append contract.
  test("transcript.user.delta passes the latest text through without concatenating", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "transcript.user.delta", item_id: "i1", text: "what's the" });
    emitMessage(raw, { type: "transcript.user.delta", item_id: "i1", text: "what's the weather" });

    expect(callbacks.onUserTranscriptPartial).toHaveBeenLastCalledWith("what's the weather");
    // A partial must never reach history — only the final transcript.user does.
    expect(callbacks.onUserTranscript).not.toHaveBeenCalled();
  });

  // transcript.agent.delta is word-level, so unlike the user stream it HAS to
  // accumulate: onAgentTranscriptPartial replaces the reply's rendered text,
  // and emitting a bare word would show the caption as just that word.
  test("transcript.agent.delta accumulates words into cumulative reply text", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "reply.started", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent.delta", delta: "It's", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent.delta", delta: "sunny", reply_id: "r1" });

    expect(callbacks.onAgentTranscriptPartial).toHaveBeenCalledTimes(2);
    expect(callbacks.onAgentTranscriptPartial).toHaveBeenLastCalledWith("It's sunny");
  });

  test("transcript.agent.delta resets its accumulator on the next reply", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "reply.started", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent.delta", delta: "first", reply_id: "r1" });
    emitMessage(raw, { type: "reply.started", reply_id: "r2" });
    emitMessage(raw, { type: "transcript.agent.delta", delta: "second", reply_id: "r2" });

    expect(callbacks.onAgentTranscriptPartial).toHaveBeenLastCalledWith("second");
  });

  // The docs call the payload a "word (or token)". A word carries no spacing of
  // its own and a token usually does, so joining has to handle both: bare words
  // get a separator, pre-spaced tokens must not be double-spaced.
  test("transcript.agent.delta does not double-space a delta that carries its own space", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "reply.started", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent.delta", delta: "It's", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent.delta", delta: " sunny", reply_id: "r1" });

    expect(callbacks.onAgentTranscriptPartial).toHaveBeenLastCalledWith("It's sunny");
  });

  test("transcript.agent.delta attaches trailing punctuation without a space", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "reply.started", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent.delta", delta: "Tokyo", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent.delta", delta: ".", reply_id: "r1" });

    expect(callbacks.onAgentTranscriptPartial).toHaveBeenLastCalledWith("Tokyo.");
  });

  test("transcript.agent.delta is not logged as an unrecognised message type", async () => {
    const { raw, logger } = await setupHandle();

    emitMessage(raw, { type: "transcript.agent.delta", delta: "hi", reply_id: "r1" });

    expect(droppedTypes(logger)).not.toContain("transcript.agent.delta");
  });

  // The final transcript still owns history: partials must not push messages,
  // so a reply that streams deltas and then commits appears exactly once.
  test("a delta stream followed by the final transcript.agent reports both", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "reply.started", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent.delta", delta: "Done", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent", text: "Done.", reply_id: "r1" });

    expect(callbacks.onAgentTranscriptPartial).toHaveBeenCalledWith("Done");
    expect(callbacks.onAgentTranscript).toHaveBeenCalledWith("Done.", false);
  });
});

// `reply.audio` is deliberately unlogged (~95% of inbound traffic), which left
// the two ways a reply can fail indistinguishable in the logs: a reply that
// streamed audio but never sent `transcript.agent` and one that produced nothing
// at all both appear as a bare `reply.started` → `reply.done` pair. Both occur
// against the live service, and they have different causes.
describe("connectS2s reply accounting", () => {
  async function setupWithLogSpies(sid = "sess-abc") {
    const { raw, createWebSocket, logger } = createTestS2s();
    const info = vi.fn();
    const warn = vi.fn();
    logger.info = info;
    logger.warn = warn;
    await connectS2s({
      apiKey: "test-key",
      config: s2sConfig,
      createWebSocket,
      callbacks: makeMockCallbacks(),
      logger,
      sid,
    });
    return { raw, info, warn };
  }

  function replyDoneFields(info: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const calls = info.mock.calls.filter((c) => c[0] === "S2S << reply.done");
    return (calls.at(-1)?.[1] ?? {}) as Record<string, unknown>;
  }

  function audioFrame(bytes: number[]): Record<string, unknown> {
    return { type: "reply.audio", data: Buffer.from(bytes).toString("base64") };
  }

  test("reply.done reports the reply's audio and transcript accounting", async () => {
    const { raw, info } = await setupWithLogSpies();

    emitMessage(raw, { type: "reply.started", reply_id: "r1" });
    emitMessage(raw, audioFrame([1, 2, 3, 4]));
    emitMessage(raw, audioFrame([5, 6]));
    emitMessage(raw, { type: "transcript.agent", text: "Hi there." });
    emitMessage(raw, { type: "reply.done", status: "completed" });

    expect(replyDoneFields(info)).toMatchObject({
      audioChunks: 2,
      audioBytes: 6,
      agentText: "final",
    });
  });

  test("accounting is per reply, not cumulative", async () => {
    const { raw, info } = await setupWithLogSpies();

    emitMessage(raw, { type: "reply.started", reply_id: "r1" });
    emitMessage(raw, audioFrame([1, 2, 3, 4]));
    emitMessage(raw, { type: "transcript.agent", text: "one" });
    emitMessage(raw, { type: "reply.done", status: "completed" });

    emitMessage(raw, { type: "reply.started", reply_id: "r2" });
    emitMessage(raw, { type: "reply.done", status: "completed" });

    expect(replyDoneFields(info)).toMatchObject({
      audioChunks: 0,
      audioBytes: 0,
      agentText: "none",
    });
  });

  test("agentText is 'delta-only' when the final transcript never arrived", async () => {
    const { raw, info } = await setupWithLogSpies();

    emitMessage(raw, { type: "reply.started", reply_id: "r1" });
    emitMessage(raw, audioFrame([1, 2]));
    emitMessage(raw, { type: "transcript.agent.delta", delta: "Hi", reply_id: "r1" });
    emitMessage(raw, { type: "reply.done", status: "completed" });

    expect(replyDoneFields(info)).toMatchObject({ agentText: "delta-only" });
  });

  // This is the "audio plays but no text appears" symptom: against the
  // documented sequence, a tool-call follow-up reply can stream audio and never
  // send transcript.agent. Nothing in the log named it before.
  test("warns when a completed reply delivered audio but no transcript", async () => {
    const { raw, warn } = await setupWithLogSpies();

    emitMessage(raw, { type: "reply.started", reply_id: "r1" });
    emitMessage(raw, audioFrame([1, 2]));
    emitMessage(raw, { type: "reply.done", status: "completed" });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("no transcript"),
      expect.objectContaining({ sid: "sess-abc", audioChunks: 1 }),
    );
  });

  // The "goes silent after tool calls" symptom.
  test("warns when a completed reply produced no audio at all", async () => {
    const { raw, warn } = await setupWithLogSpies();

    emitMessage(raw, { type: "reply.started", reply_id: "r1" });
    emitMessage(raw, { type: "reply.done", status: "completed" });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("no audio"),
      expect.objectContaining({ sid: "sess-abc" }),
    );
  });

  // A tool-call reply carries the call and nothing else by design — it is the
  // one shape that legitimately has neither audio nor text.
  test("does not warn about a tool-call reply carrying no audio or transcript", async () => {
    const { raw, warn } = await setupWithLogSpies();

    emitMessage(raw, { type: "reply.started", reply_id: "fc-c1" });
    emitMessage(raw, { type: "tool.call", call_id: "c1", name: "get_order", arguments: {} });
    emitMessage(raw, { type: "reply.done", status: "completed" });

    expect(warn).not.toHaveBeenCalled();
  });

  // An interrupted reply is expected to be partial; warning on it would fire on
  // every barge-in, which is normal conversation.
  test("does not warn about an interrupted reply", async () => {
    const { raw, warn } = await setupWithLogSpies();

    emitMessage(raw, { type: "reply.started", reply_id: "r1" });
    emitMessage(raw, { type: "reply.done", status: "interrupted" });

    expect(warn).not.toHaveBeenCalled();
  });
});

// The live service can finish a reply without the final `transcript.agent`
// (observed on tool-call follow-up replies, contrary to the documented
// sequence). Deltas render in the client as they arrive, but only the final
// transcript pushes the assistant turn into history — so reply.done commits
// the accumulated delta text when no final ever came.
describe("connectS2s delta transcript commit on reply.done", () => {
  test("commits accumulated deltas as the final transcript when none arrived", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "reply.started", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent.delta", delta: "Your", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent.delta", delta: "order", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent.delta", delta: "shipped", reply_id: "r1" });
    emitMessage(raw, { type: "reply.done", status: "completed" });

    expect(callbacks.onAgentTranscript).toHaveBeenCalledOnce();
    expect(callbacks.onAgentTranscript).toHaveBeenCalledWith("Your order shipped", false);
    // The commit must land before onReplyDone: SessionCore pushes history from
    // onAgentTranscript, and onReplyDone is what settles the turn.
    const order = (fn: unknown) =>
      (fn as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ?? 0;
    expect(order(callbacks.onAgentTranscript)).toBeLessThan(order(callbacks.onReplyDone));
  });

  test("does not re-commit when the final transcript.agent did arrive", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "reply.started", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent.delta", delta: "Hi", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent", text: "Hi there.", reply_id: "r1" });
    emitMessage(raw, { type: "reply.done", status: "completed" });

    expect(callbacks.onAgentTranscript).toHaveBeenCalledOnce();
    expect(callbacks.onAgentTranscript).toHaveBeenCalledWith("Hi there.", false);
  });

  // The client flushed the interrupted reply on barge-in; committing its text
  // afterwards would re-render words the user just cut off.
  test("does not commit deltas on an interrupted reply", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "reply.started", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent.delta", delta: "Half", reply_id: "r1" });
    emitMessage(raw, { type: "reply.done", status: "interrupted" });

    expect(callbacks.onAgentTranscript).not.toHaveBeenCalled();
    expect(callbacks.onCancelled).toHaveBeenCalledOnce();
  });

  test("a duplicate reply.done does not commit the same reply twice", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "reply.started", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent.delta", delta: "Once", reply_id: "r1" });
    emitMessage(raw, { type: "reply.done", status: "completed" });
    emitMessage(raw, { type: "reply.done", status: "completed" });

    expect(callbacks.onAgentTranscript).toHaveBeenCalledOnce();
  });

  // The upstream zero-transcript shape (audio, no deltas, no final): there is
  // nothing to commit, so no synthetic transcript may be invented.
  test("commits nothing when the reply carried no transcript at all", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "reply.started", reply_id: "r1" });
    emitMessage(raw, {
      type: "reply.audio",
      data: Buffer.from([1, 2, 3, 4]).toString("base64"),
    });
    emitMessage(raw, { type: "reply.done", status: "completed" });

    expect(callbacks.onAgentTranscript).not.toHaveBeenCalled();
    expect(callbacks.onReplyDone).toHaveBeenCalledOnce();
  });
});
