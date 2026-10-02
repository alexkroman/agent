// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { makeLogger } from "../_logger-test-utils.ts";
import {
  createRealtimeMessageHandler,
  createRealtimeTurnBuffers,
} from "./openai-realtime-events.ts";

function harness() {
  const callbacks = {
    report: vi.fn(),
    onAudioChunk: vi.fn(),
    onReplyStarted: vi.fn(),
  };
  // A reply in flight, so response content is dispatched; the gate itself is
  // held end-to-end by `openai-realtime-lifecycle-race.test.ts`.
  const lifecycle = { send: vi.fn(), phase: () => "live" as const, replying: () => true };
  const buffers = createRealtimeTurnBuffers();
  const log = makeLogger();
  const reportError = vi.fn();
  const handle = createRealtimeMessageHandler({ callbacks, lifecycle, buffers, log, reportError });
  const send = (event: Record<string, unknown>): void => handle(JSON.stringify(event));
  return { callbacks, lifecycle, buffers, log, reportError, handle, send };
}

describe("createRealtimeTurnBuffers", () => {
  test("clear empties both the transcript and the tool-call buffers", () => {
    const buffers = createRealtimeTurnBuffers();
    buffers.transcripts.set("i1", "half a sen");
    buffers.tools.set("i2", { callId: "c", name: "n", argsBuffer: "{" });
    buffers.clear();
    expect(buffers.transcripts.size).toBe(0);
    expect(buffers.tools.size).toBe(0);
  });
});

describe("createRealtimeMessageHandler", () => {
  test("audio deltas decode to bytes for the client", () => {
    const { callbacks, send } = harness();
    send({ type: "response.output_audio.delta", delta: Buffer.from([1, 2, 3]).toString("base64") });
    expect(callbacks.onAudioChunk).toHaveBeenCalledTimes(1);
    expect(callbacks.onAudioChunk.mock.calls[0]?.[0]).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("the plain service events map to their reports", () => {
    const { callbacks, send } = harness();
    send({ type: "response.output_audio.done" });
    send({ type: "input_audio_buffer.speech_stopped" });
    send({ type: "conversation.item.input_audio_transcription.completed", transcript: "hi" });
    expect(callbacks.report.mock.calls).toEqual([
      [{ type: "audio.completed" }],
      [{ type: "speech.stopped" }],
      [{ type: "userTranscript.committed", text: "hi" }],
    ]);
  });

  test("speech_started tells the lifecycle (a barge-in) AND reports the edge", () => {
    const { callbacks, lifecycle, send } = harness();
    send({ type: "input_audio_buffer.speech_started" });
    expect(lifecycle.send).toHaveBeenCalledWith({ type: "SPEECH_STARTED" });
    expect(callbacks.report).toHaveBeenCalledWith({ type: "speech.started" });
  });

  test("response boundaries go to the lifecycle, never straight to the client", () => {
    const { callbacks, lifecycle, send } = harness();
    send({ type: "response.created", response: { id: "resp_1" } });
    send({ type: "response.done" });
    expect(lifecycle.send.mock.calls).toEqual([
      [{ type: "REPLY_STARTED", replyId: "resp_1" }],
      [{ type: "REPLY_DONE" }],
    ]);
    expect(callbacks.report).not.toHaveBeenCalled();
  });

  test("agent transcript deltas are buffered per item and committed once, on done", () => {
    const { callbacks, buffers, send } = harness();
    send({ type: "response.output_audio_transcript.delta", item_id: "a", delta: "Hel" });
    send({ type: "response.output_audio_transcript.delta", item_id: "b", delta: "Other" });
    send({ type: "response.output_audio_transcript.delta", item_id: "a", delta: "lo" });
    expect(callbacks.report).not.toHaveBeenCalled();
    send({ type: "response.output_audio_transcript.done", item_id: "a" });
    expect(callbacks.report).toHaveBeenCalledWith({
      type: "agentTranscript.committed",
      text: "Hello",
    });
    expect([...buffers.transcripts.keys()]).toEqual(["b"]);
  });

  test("an empty transcript commits nothing", () => {
    const { callbacks, send } = harness();
    send({ type: "response.output_audio_transcript.done", item_id: "never-seen" });
    expect(callbacks.report).not.toHaveBeenCalled();
  });

  test("a streamed function call is assembled from its deltas and reported once", () => {
    const { callbacks, buffers, send } = harness();
    send({
      type: "response.output_item.added",
      item: { id: "it1", type: "function_call", name: "lookup", call_id: "call_1" },
    });
    send({ type: "response.function_call_arguments.delta", item_id: "it1", delta: '{"q":' });
    send({ type: "response.function_call_arguments.delta", item_id: "it1", delta: '"otters"}' });
    send({ type: "response.function_call_arguments.done", item_id: "it1" });
    expect(callbacks.report).toHaveBeenCalledWith({
      type: "tool.called",
      toolCallId: "call_1",
      toolName: "lookup",
      args: { q: "otters" },
    });
    expect(buffers.tools.size).toBe(0);
  });

  test("the done frame's own fields win over the buffered ones", () => {
    const { callbacks, send } = harness();
    send({
      type: "response.output_item.added",
      item: { id: "it1", type: "function_call", name: "buffered", call_id: "buffered_id" },
    });
    send({
      type: "response.function_call_arguments.done",
      item_id: "it1",
      call_id: "call_9",
      name: "lookup",
      arguments: '{"q":1}',
    });
    expect(callbacks.report).toHaveBeenCalledWith({
      type: "tool.called",
      toolCallId: "call_9",
      toolName: "lookup",
      args: { q: 1 },
    });
  });

  test("an output item that is not a function call opens no tool buffer", () => {
    const { buffers, send } = harness();
    send({ type: "response.output_item.added", item: { id: "m1", type: "message" } });
    expect(buffers.tools.size).toBe(0);
  });

  test("malformed tool arguments warn and become {}", () => {
    const { callbacks, log, send } = harness();
    send({
      type: "response.function_call_arguments.done",
      item_id: "x",
      call_id: "c1",
      name: "lookup",
      arguments: "{not json",
    });
    expect(log.warn).toHaveBeenCalledWith("OpenAI Realtime: invalid tool args JSON", {
      name: "lookup",
      callId: "c1",
    });
    expect(callbacks.report).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tool.called", args: {} }),
    );
  });

  test("an in-band error is a NON-fatal report and leaves the turn buffers alone", () => {
    const { buffers, reportError, send } = harness();
    send({ type: "response.output_audio_transcript.delta", item_id: "a", delta: "still talking" });
    send({ type: "error", error: { message: "conversation_already_has_active_response" } });
    expect(reportError).toHaveBeenCalledWith(
      "internal",
      "conversation_already_has_active_response",
    );
    expect(buffers.transcripts.get("a")).toBe("still talking");
  });

  test("an error event with no message gets a generic one", () => {
    const { reportError, send } = harness();
    send({ type: "error" });
    expect(reportError).toHaveBeenCalledWith("internal", "OpenAI Realtime error");
  });

  test("non-JSON is warned and dropped; JSON that is not an object is ignored", () => {
    const { callbacks, lifecycle, log, handle } = harness();
    handle("not json");
    handle("[1,2]");
    expect(log.warn).toHaveBeenCalledWith("OpenAI Realtime: invalid JSON");
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(callbacks.report).not.toHaveBeenCalled();
    expect(lifecycle.send).not.toHaveBeenCalled();
  });

  test("an unknown event type is logged at debug and does nothing else", () => {
    const { callbacks, lifecycle, log, send } = harness();
    send({ type: "rate_limits.updated" });
    expect(log.debug).toHaveBeenCalledWith("OpenAI Realtime: unhandled event", {
      type: "rate_limits.updated",
    });
    expect(callbacks.report).not.toHaveBeenCalled();
    expect(lifecycle.send).not.toHaveBeenCalled();
  });
});
