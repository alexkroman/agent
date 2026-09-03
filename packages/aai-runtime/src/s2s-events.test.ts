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
    const callbacks = makeMockCallbacks();
    const { raw, logger } = await setupHandle(callbacks);

    emitMessage(raw, { type: "reply.content_part.started" });
    emitMessage(raw, { type: "reply.content_part.done" });

    // "Silently" and "ignored" are two separate claims, and the body checked
    // neither — it only proved the emits did not throw. Ignored: no callback
    // ran. Silently: the parser RECOGNISES them, so they are absent from the
    // dropped list rather than warning twice per reply. Asserting the second
    // half is what revealed they were NOT recognised at all.
    for (const cb of Object.values(callbacks)) expect(cb).not.toHaveBeenCalled();
    // The stronger claim, now that the logger is per-session: not merely that
    // these two types are absent from the dropped list, but that the parser
    // dropped NOTHING at all.
    expect(droppedTypes(logger)).toEqual([]);
  });
});

const UNRECOGNISED_PREFIX = "S2S << unrecognised message type: ";

/**
 * Message types the parser rejected, read back out of its warnings.
 *
 * These specs used to assert a type was ABSENT from this list rather than that
 * nothing was warned at all, because `setupHandle`'s logger was effectively
 * shared: `createTestS2s` spread `silentLogger`, which copies the same
 * `vi.fn()` references, so one accumulating call log served every session in
 * the file. Each session now gets its own `makeLogger()`, so an empty list is
 * a meaningful assertion and the stronger form is available where it fits.
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

  // `transcript.agent.delta` DOES arrive from the live service — this suite
  // previously asserted the opposite (that it was dropped as unrecognised).
  // See `_s2s-reply.ts` for the re-measurement.
  test("transcript.agent.delta is not logged as an unrecognised message type", async () => {
    const { raw, logger } = await setupHandle();

    emitMessage(raw, { type: "reply.started", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent.delta", delta: "Thank", reply_id: "r1" });

    expect(droppedTypes(logger)).not.toContain("transcript.agent.delta");
  });

  // Unlike `transcript.user.delta`, whose `text` is cumulative, these really are
  // increments — one word each, punctuation attached, no spacing of their own.
  // They must be APPENDED, and the partial carries the accumulation so the
  // callback keeps its replace-not-append contract.
  test("transcript.agent.delta accumulates words into the reply's text so far", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "reply.started", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent.delta", delta: "Thank", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent.delta", delta: "you", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent.delta", delta: "for", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent.delta", delta: "calling.", reply_id: "r1" });

    expect(callbacks.onAgentTranscriptPartial).toHaveBeenLastCalledWith("Thank you for calling.");
    // A partial never reaches history; the final (or reply.done) owns that.
    expect(callbacks.onAgentTranscript).not.toHaveBeenCalled();
  });

  test("a new reply.started resets the delta accumulation", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "reply.started", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent.delta", delta: "First", reply_id: "r1" });
    emitMessage(raw, { type: "reply.started", reply_id: "r2" });
    emitMessage(raw, { type: "transcript.agent.delta", delta: "Second", reply_id: "r2" });

    expect(callbacks.onAgentTranscriptPartial).toHaveBeenLastCalledWith("Second");
  });

  // `text` as an alias for `delta`, for the same reason `tool.call` accepts
  // `arguments`/`args`: a silent name mismatch drops the frame entirely.
  test("transcript.agent.delta accepts `text` as an alias for `delta`", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "reply.started", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent.delta", text: "Hello", reply_id: "r1" });

    expect(callbacks.onAgentTranscriptPartial).toHaveBeenCalledWith("Hello");
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

  // This is the "audio plays but no text appears" symptom, and it is what every
  // tool-call turn looks like against the live service: the reply after
  // `tool.result` streams audio and never sends transcript.agent. Nothing in
  // the log named it before.
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
describe("connectS2s transcript-less replies", () => {
  // Audio, no `transcript.agent`, and no deltas either: nothing to commit and
  // nothing to reconstruct from, so the turn settles with no assistant text.
  // Inventing text here would put words the agent never said into history.
  test("a reply with audio but no transcript at all commits no assistant text", async () => {
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

  // The live tool-preamble turn: audio streams, deltas arrive, `transcript.agent`
  // never does. Measured at 5 of 20 replies in one retail session — 116 words
  // that are otherwise unrecoverable, since deltas are their only carrier. The
  // accumulation is committed on reply.done, BEFORE onReplyDone, so it lands in
  // the turn it belongs to.
  test("a completed reply with deltas but no final commits the accumulated text", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "reply.started", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent.delta", delta: "Let", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent.delta", delta: "me", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent.delta", delta: "check.", reply_id: "r1" });
    emitMessage(raw, { type: "reply.done", status: "completed" });

    expect(callbacks.onAgentTranscript).toHaveBeenCalledOnce();
    expect(callbacks.onAgentTranscript).toHaveBeenCalledWith("Let me check.", false);
    expect(callbacks.onReplyDone).toHaveBeenCalledOnce();
  });

  test("a reply whose final arrives does not also commit the accumulation", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "reply.started", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent.delta", delta: "Let", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent", text: "Let me check.", reply_id: "r1" });
    emitMessage(raw, { type: "reply.done", status: "completed" });

    expect(callbacks.onAgentTranscript).toHaveBeenCalledOnce();
    expect(callbacks.onAgentTranscript).toHaveBeenCalledWith("Let me check.", false);
  });

  // The delta batch covers the WHOLE composed reply, while a real
  // `transcript.agent` with `interrupted: true` is trimmed to what was actually
  // spoken. Committing the accumulation on a barge-in would therefore credit the
  // agent with words the caller talked over and never heard.
  test("an INTERRUPTED reply never commits the accumulated deltas", async () => {
    const callbacks = makeMockCallbacks();
    const { raw } = await setupHandle(callbacks);

    emitMessage(raw, { type: "reply.started", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent.delta", delta: "Your", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent.delta", delta: "order", reply_id: "r1" });
    emitMessage(raw, { type: "transcript.agent.delta", delta: "shipped.", reply_id: "r1" });
    emitMessage(raw, { type: "reply.done", status: "interrupted" });

    expect(callbacks.onAgentTranscript).not.toHaveBeenCalled();
    expect(callbacks.onCancelled).toHaveBeenCalledOnce();
    expect(callbacks.onReplyDone).not.toHaveBeenCalled();
  });
});
