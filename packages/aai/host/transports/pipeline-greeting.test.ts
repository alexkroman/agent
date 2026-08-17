// Copyright 2026 the AAI authors. MIT license.

/**
 * The pipeline transport's greeting turn — the one reply the agent speaks
 * without being asked. Split out of pipeline-transport.test.ts, which had run
 * up against the test file-length cap.
 *
 * Two dispatch points, and the distinction between them is the substance of
 * this file: session start (`onAudioReady`, suppressed by `skipGreeting` for a
 * resume) and `reset()`, which discards the conversation and therefore opens
 * the next one the way every conversation opens.
 */

import { describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel } from "../_pipeline-test-fakes.ts";
import { makeOpts, useVirtualTime } from "./_pipeline-transport-harness.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";

const GREETING = "Hi there!";

/** `makeOpts` with a greeting declared — the harness default is `""`. */
function greetingOpts(overrides: Parameters<typeof makeOpts>[0] = {}) {
  return makeOpts({ sessionConfig: { systemPrompt: "s", greeting: GREETING }, ...overrides });
}

useVirtualTime();

describe("pipeline greeting", () => {
  describe("at session start", () => {
    test("sends greeting via ttsSession.sendText and fires onReplyStarted + onAgentTranscript + onReplyDone", async () => {
      const { opts, tts, callbacks } = greetingOpts();
      const t = createPipelineTransport(opts);
      await t.start();
      await vi.waitFor(() => {
        expect(callbacks.reported("reply.completed")).toHaveBeenCalledOnce();
      });
      expect(tts.last()?.textChunks).toContain(GREETING);
      expect(callbacks.onReplyStarted).toHaveBeenCalledWith(expect.stringContaining("greeting"));
      expect(callbacks.reported("agent-transcript.committed")).toHaveBeenCalledWith({
        type: "agent-transcript.committed",
        text: GREETING,
      });
      // onAudioDone is owned by session-core's flushReply, not the transport.
      expect(callbacks.reported("audio.completed")).not.toHaveBeenCalled();
      await t.stop();
    });

    test("also pushes the greeting via sttSession.updateAgentContext", async () => {
      const { opts, stt, callbacks } = greetingOpts();
      const t = createPipelineTransport(opts);
      await t.start();
      await vi.waitFor(() => {
        expect(callbacks.reported("reply.completed")).toHaveBeenCalledOnce();
      });
      expect(stt.last()?.updateAgentContext).toHaveBeenCalledWith(GREETING);
      await t.stop();
    });

    test("publishes the greeting transcript exactly once", async () => {
      // The whole greeting reaches TTS in one call, so the interim transcript
      // would be a byte-identical copy of the final: the turn emitted the same
      // `agent_transcript` frame twice, final first — the inverse of the
      // documented partial-then-final order.
      const { opts, callbacks } = greetingOpts();
      const t = createPipelineTransport(opts);
      await t.start();
      await vi.waitFor(() => {
        expect(callbacks.reported("reply.completed")).toHaveBeenCalledOnce();
      });
      expect(callbacks.reported("agent-transcript.committed")).toHaveBeenCalledExactlyOnceWith({
        type: "agent-transcript.committed",
        text: GREETING,
      });
      expect(callbacks.reported("agent-transcript.updated")).not.toHaveBeenCalled();
      await t.stop();
    });

    test("skipGreeting suppresses the greeting turn", async () => {
      const { opts, tts, callbacks } = greetingOpts({ skipGreeting: true });
      const t = createPipelineTransport(opts);
      await t.start();
      await vi.advanceTimersByTimeAsync(20);
      expect(callbacks.onReplyStarted).not.toHaveBeenCalled();
      expect(tts.last()?.textChunks).toHaveLength(0);
      await t.stop();
    });

    test("a skipGreeting THUNK is resolved when the greeting would fire, not at construction", async () => {
      // The runtime cannot answer this at construction: `?sessionId=` suppresses
      // the greeting on the id's mere presence, and whether that resume recovered
      // anything is only known once the event log and slot store have been read
      // — inside the `session.start()` window, i.e. after the transport exists.
      // So the answer is a thunk, and this is the property that makes it work.
      let recovered = false;
      const { opts, tts, callbacks } = greetingOpts({ skipGreeting: () => recovered });
      const t = createPipelineTransport(opts);
      // Flipped AFTER construction and before the audio-ready edge — exactly
      // where `attachSessionStream`/`attachSessionState` land.
      recovered = true;
      await t.start();
      await vi.advanceTimersByTimeAsync(20);
      expect(callbacks.onReplyStarted).not.toHaveBeenCalled();
      expect(tts.last()?.textChunks).toHaveLength(0);
      await t.stop();
    });

    test("a resume that recovered NOTHING greets", async () => {
      // The failure this closes: a well-formed id naming a session whose state is
      // gone — a reload past SESSION_RESUME_GRACE_MS, or a guest that self-exited
      // on idle — used to give a connected, mic-live, HISTORYLESS session with the
      // greeting suppressed. An agent that is silent for no stated reason.
      const { opts, tts, callbacks } = greetingOpts({ skipGreeting: () => false });
      const t = createPipelineTransport(opts);
      await t.start();
      await vi.waitFor(() => {
        expect(callbacks.reported("reply.completed")).toHaveBeenCalledOnce();
      });
      expect(tts.last()?.textChunks).toContain(GREETING);
      await t.stop();
    });
  });

  describe("on reset()", () => {
    test("replays the greeting", async () => {
      // The client's "New Conversation" button is a `reset` frame and nothing
      // else, so without this the next conversation opens on silence — the
      // agent's own declared opening line is the one turn it never speaks
      // again for the life of the call.
      const { opts, tts, callbacks } = greetingOpts();
      const t = createPipelineTransport(opts);
      await t.start();
      await vi.waitFor(() => {
        expect(callbacks.reported("reply.completed")).toHaveBeenCalledOnce();
      });

      t.reset?.();
      await vi.waitFor(() => {
        expect(callbacks.reported("reply.completed")).toHaveBeenCalledTimes(2);
      });
      expect(tts.last()?.textChunks.filter((c) => c === GREETING)).toHaveLength(2);
      expect(callbacks.reported("agent-transcript.committed")).toHaveBeenCalledTimes(2);
      await t.stop();
    });

    test("greets a resumed session that skipped its own opening greeting", async () => {
      // `skipGreeting` is scoped to the CONNECTION's start — it says "this is a
      // reconnect, the caller already heard the opening line". A reset is the
      // opposite claim: the conversation is discarded, so the next one greets.
      const { opts, tts, callbacks } = greetingOpts({ skipGreeting: true });
      const t = createPipelineTransport(opts);
      await t.start();
      await vi.advanceTimersByTimeAsync(20);
      expect(callbacks.onReplyStarted).not.toHaveBeenCalled();

      t.reset?.();
      await vi.waitFor(() => {
        expect(callbacks.reported("reply.completed")).toHaveBeenCalledOnce();
      });
      expect(tts.last()?.textChunks).toContain(GREETING);
      await t.stop();
    });

    test("starts no turn when the agent declares no greeting", async () => {
      // The harness default is `greeting: ""`, i.e. an agent that opens on
      // silence deliberately. A reset must not invent a turn for it.
      const { opts, callbacks } = makeOpts();
      const t = createPipelineTransport(opts);
      await t.start();
      t.reset?.();
      await vi.advanceTimersByTimeAsync(20);
      expect(callbacks.onReplyStarted).not.toHaveBeenCalled();
      await t.stop();
    });

    test("the replayed greeting lands in the fresh history, not the discarded one", async () => {
      // Ordering: reset() clears history and THEN queues the greeting, so the
      // next turn's LLM request carries the new greeting and none of the
      // conversation that preceded the reset.
      const llm = createFakeLanguageModel({ script: [{ type: "text", text: "Sure." }] });
      const { opts, stt, callbacks } = greetingOpts({ llm });
      const t = createPipelineTransport(opts);
      await t.start();
      await vi.waitFor(() => {
        expect(callbacks.reported("reply.completed")).toHaveBeenCalledOnce();
      });

      stt.last()?.fireFinal("remember the number nine");
      await vi.waitFor(() => {
        expect(llm.calls.length).toBe(1);
      });

      t.reset?.();
      await vi.waitFor(() => {
        expect(callbacks.reported("agent-transcript.committed")).toHaveBeenCalledTimes(2);
      });
      stt.last()?.fireFinal("what now");
      await vi.waitFor(() => {
        expect(llm.calls.length).toBe(2);
      });

      const request = JSON.stringify(llm.calls.at(-1));
      expect(request).not.toContain("remember the number nine");
      expect(request).toContain(GREETING);
      await t.stop();
    });
  });
});
