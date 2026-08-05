// Copyright 2026 the AAI authors. MIT license.
// Voice-UX event specs for the pipeline transport: user-speaking edge events
// (speech_started/speech_stopped derived from the STT transcript stream),
// interim-transcript forwarding, false-interruption recovery, and the
// configurable hold phrase. Barge-in mechanics live in
// pipeline-transport-barge-in.test.ts; shared helpers in
// _pipeline-transport-harness.ts.

import { describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel, type ScriptedPart } from "../_pipeline-test-fakes.ts";
import { tick } from "../_test-utils.ts";
import { inFlightReplyScript, makeOpts, noopToolSchema } from "./_pipeline-transport-harness.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";

describe("PipelineTransport", () => {
  describe("user-speaking events", () => {
    test("first partial fires onSpeechStarted once; commit fires onSpeechStopped", async () => {
      const { opts, stt, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script: [{ type: "text", text: "hi" }] }),
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.firePartial("hello");
      stt.last()?.firePartial("hello there");
      expect(callbacks.onSpeechStarted).toHaveBeenCalledTimes(1);
      expect(callbacks.onSpeechStopped).not.toHaveBeenCalled();

      stt.last()?.fireFinal("hello there agent");
      await vi.waitFor(() => {
        expect(callbacks.onUserTranscript).toHaveBeenCalledWith("hello there agent");
      });
      expect(callbacks.onSpeechStopped).toHaveBeenCalledTimes(1);
      await t.stop();
    });

    test("a final with no preceding partial still fires the speaking edge events", async () => {
      const { opts, stt, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script: [{ type: "text", text: "hi" }] }),
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("short utterance.");
      await vi.waitFor(() => {
        expect(callbacks.onUserTranscript).toHaveBeenCalledWith("short utterance.");
      });
      expect(callbacks.onSpeechStarted).toHaveBeenCalledTimes(1);
      expect(callbacks.onSpeechStopped).toHaveBeenCalledTimes(1);
      await t.stop();
    });

    test("interim transcripts are forwarded via onUserTranscriptPartial", async () => {
      const { opts, stt, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script: [{ type: "text", text: "hi" }] }),
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.firePartial("track my");
      stt.last()?.firePartial("track my order");
      expect(callbacks.onUserTranscriptPartial).toHaveBeenNthCalledWith(1, "track my");
      expect(callbacks.onUserTranscriptPartial).toHaveBeenNthCalledWith(2, "track my order");
      await t.stop();
    });

    test("empty partials fire neither speaking events nor interim transcripts", async () => {
      const { opts, stt, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script: [{ type: "text", text: "hi" }] }),
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.firePartial("");
      stt.last()?.firePartial("   ");
      expect(callbacks.onSpeechStarted).not.toHaveBeenCalled();
      expect(callbacks.onUserTranscriptPartial).not.toHaveBeenCalled();
      await t.stop();
    });
  });

  describe("false-interruption recovery", () => {
    // Long enough that the reply is still in flight when each spec barges in —
    // see inFlightReplyScript. Aborted by the barge-in, so it costs no time.
    const script = inFlightReplyScript();

    test("a partial barge-in with no committed turn resumes the reply after the window", async () => {
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({
          steps: [script, [{ type: "text", text: "As I was saying…" }]],
          delayMs: 20,
        }),
        falseInterruptionTimeoutMs: 40,
        // The resume is deferred until the speaking edge closes (the noise
        // partial opens it and no final ever arrives), so the watchdog is what
        // releases it — shortened here to keep the spec inside vi.waitFor's
        // window. The specs asserting NO resume keep the shipped value.
        speechIdleTimeoutMs: 60,
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("where is my order");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });
      // Barge-in requires the agent to be audibly speaking, not merely mid-turn.
      tts.last()?.fireAudio(new Int16Array(2400));

      // Noise transcribed as a partial — never followed by a final.
      stt.last()?.firePartial("uh what");
      expect(callbacks.onCancelled).toHaveBeenCalled();

      // The recovery window elapses with no committed turn → resume turn runs.
      await vi.waitFor(() => {
        expect(callbacks.onReplyStarted).toHaveBeenCalledTimes(2);
      });
      await vi.waitFor(() => {
        expect(callbacks.onAgentTranscript).toHaveBeenCalledWith("As I was saying…", false);
      });
      // The synthetic continuation prompt is never surfaced as a user transcript.
      expect(callbacks.onUserTranscript).toHaveBeenCalledTimes(1);
      // The unresolved speaking edge from the noise partial is closed out.
      expect(callbacks.onSpeechStopped).toHaveBeenCalled();
      await t.stop();
    });

    test("a final after the barge-in is a real turn — no resume fires", async () => {
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({
          steps: [script, [{ type: "text", text: "ok" }]],
          delayMs: 20,
        }),
        falseInterruptionTimeoutMs: 40,
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("where is my order");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });
      // Barge-in requires the agent to be audibly speaking, not merely mid-turn.
      tts.last()?.fireAudio(new Int16Array(2400));

      stt.last()?.firePartial("wait actually");
      expect(callbacks.onCancelled).toHaveBeenCalled();
      stt.last()?.fireFinal("wait actually cancel it.");
      await vi.waitFor(() => {
        expect(callbacks.onUserTranscript).toHaveBeenCalledWith("wait actually cancel it.");
      });

      // Let the (cancelled) recovery window pass — no third reply appears.
      await new Promise((r) => setTimeout(r, 80));
      expect(callbacks.onReplyStarted).toHaveBeenCalledTimes(2);
      await t.stop();
    });

    test("falseInterruptionTimeoutMs 0 disables recovery", async () => {
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script, delayMs: 20 }),
        falseInterruptionTimeoutMs: 0,
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("where is my order");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });
      // Barge-in requires the agent to be audibly speaking, not merely mid-turn.
      tts.last()?.fireAudio(new Int16Array(2400));

      stt.last()?.firePartial("uh what");
      expect(callbacks.onCancelled).toHaveBeenCalled();

      await new Promise((r) => setTimeout(r, 60));
      expect(callbacks.onReplyStarted).toHaveBeenCalledTimes(1);
      await t.stop();
    });

    test("a barge-in on the client playback tail (turn already finished) resumes with the cut point", async () => {
      // The reply completed server-side while its audio was still playing out
      // client-side. A noise partial in that window used to kill the rest of
      // the reply permanently — full transcript on screen, voice dead
      // mid-sentence — because no recovery was armed for a finished turn.
      const llm = createFakeLanguageModel({
        steps: [
          [{ type: "text", text: "20, 19, 18…" }],
          [{ type: "text", text: "As I was counting…" }],
        ],
      });
      const { opts, stt, tts, callbacks } = makeOpts({
        llm,
        falseInterruptionTimeoutMs: 40,
        // The resume is deferred until the speaking edge closes (the noise
        // partial opens it and no final ever arrives), so the watchdog is what
        // releases it — shortened here to keep the spec inside vi.waitFor's
        // window. The specs asserting NO resume keep the shipped value.
        speechIdleTimeoutMs: 60,
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("count down from 20");
      await vi.waitFor(() => {
        expect(callbacks.onReplyDone).toHaveBeenCalled();
      });

      // 10 s of PCM16 at the default 24 kHz — client playback lags well behind.
      tts.last()?.fireAudio(new Int16Array(240_000));
      stt.last()?.firePartial("uh what");
      expect(callbacks.onCancelled).toHaveBeenCalled();

      // The window elapses with no committed turn → the reply resumes.
      await vi.waitFor(() => {
        expect(callbacks.onReplyStarted).toHaveBeenCalledTimes(2);
      });
      await vi.waitFor(() => {
        expect(callbacks.onAgentTranscript).toHaveBeenCalledWith("As I was counting…", false);
      });
      // The resume turn's synthetic prompt tells the model about the cut; it
      // is never surfaced as a user transcript.
      expect(JSON.stringify(llm.calls.at(-1))).toContain("cut off by a false interruption");
      expect(callbacks.onUserTranscript).toHaveBeenCalledTimes(1);
      await t.stop();
    });

    test("a barge-in on a playback tail the caller has essentially heard does not resume", async () => {
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script: [{ type: "text", text: "Sure." }] }),
        falseInterruptionTimeoutMs: 40,
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("thanks");
      await vi.waitFor(() => {
        expect(callbacks.onReplyDone).toHaveBeenCalled();
      });

      // 500 ms of audio — under TAIL_RESUME_MIN_UNHEARD_MS, so the cut costs
      // nothing worth a resume turn (which would only append a fragment to a
      // reply the caller heard).
      tts.last()?.fireAudio(new Int16Array(12_000));
      stt.last()?.firePartial("uh what");
      expect(callbacks.onCancelled).toHaveBeenCalled();

      await new Promise((r) => setTimeout(r, 80));
      expect(callbacks.onReplyStarted).toHaveBeenCalledTimes(1);
      await t.stop();
    });

    test("a user who keeps talking is not resumed over — partials re-arm the window", async () => {
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({
          steps: [script, [{ type: "text", text: "As I was saying…" }]],
          delayMs: 20,
        }),
        falseInterruptionTimeoutMs: 40,
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("where is my order");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });
      // Barge-in requires the agent to be audibly speaking, not merely mid-turn.
      tts.last()?.fireAudio(new Int16Array(2400));

      // Barge in, then keep speaking well past the recovery window. Providers
      // that only emit a final at end-of-turn (AssemblyAI) produce exactly this
      // shape: a long run of partials with no final in sight.
      stt.last()?.firePartial("wait actually");
      expect(callbacks.onCancelled).toHaveBeenCalled();
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 25));
        stt.last()?.firePartial(`wait actually hold on ${i}`);
      }

      // ~125 ms > 40 ms window, but the agent must not have resumed over them.
      expect(callbacks.onReplyStarted).toHaveBeenCalledTimes(1);

      // The utterance finally commits as the real turn it always was.
      stt.last()?.fireFinal("wait actually hold on, cancel it.");
      await vi.waitFor(() => {
        expect(callbacks.onUserTranscript).toHaveBeenCalledWith(
          "wait actually hold on, cancel it.",
        );
      });
      await t.stop();
    });

    test("a barge-in partial's caption survives the cancel that follows it", async () => {
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script, delayMs: 20 }),
        falseInterruptionTimeoutMs: 0,
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("where is my order");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });
      // Barge-in requires the agent to be audibly speaking, not merely mid-turn.
      tts.last()?.fireAudio(new Int16Array(2400));

      stt.last()?.firePartial("stop please");
      // The client's `cancelled` handler clears userTranscript, so the interim
      // must be emitted after onCancelled or the caption is blanked.
      const partialCall = (callbacks.onUserTranscriptPartial as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0];
      const cancelledCall = (callbacks.onCancelled as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0];
      expect(partialCall).toBeGreaterThan(cancelledCall as number);
      await t.stop();
    });

    test("a final-triggered barge-in re-emits the caption after the cancel", async () => {
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script, delayMs: 20 }),
        falseInterruptionTimeoutMs: 0,
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("where is my order");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });
      // Barge-in requires the agent to be audibly speaking, not merely mid-turn.
      tts.last()?.fireAudio(new Int16Array(2400));

      // A final (no preceding partial) barges in. The turn commits right after
      // the cancel, so the client's `cancelled` handler (which clears
      // userTranscript) must run before the committed user_transcript lands —
      // the other order would blank the message it just set.
      stt.last()?.fireFinal("okay, cool.");
      expect(callbacks.onCancelled).toHaveBeenCalled();
      const cancelledCall = (callbacks.onCancelled as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0];
      const transcriptCalls = (callbacks.onUserTranscript as ReturnType<typeof vi.fn>).mock;
      const idx = transcriptCalls.calls.findIndex((c) => c[0] === "okay, cool.");
      expect(idx).not.toBe(-1);
      expect(transcriptCalls.invocationCallOrder[idx]).toBeGreaterThan(cancelledCall as number);
      await t.stop();
    });

    test("a resume mooted by the real user turn leaves no synthetic prompt in history", async () => {
      // The resume fires, the caller's final lands a beat later and moots it
      // while it is still silent. The prompt was pushed into history before the
      // stream ran and nothing rolled it back, so the model's next request
      // carried "the user did not actually say anything. Continue your reply"
      // immediately followed by what the user really said — two consecutive,
      // contradictory user messages.
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({
          // The resume arm gets a script that cannot finish on its own, and the
          // 400ms per-part delay is what makes the moot observable: the final
          // has to land while the resume is still SILENT (no text accumulated,
          // no audio fired), which is the only state the abort can roll back.
          steps: [script, script, [{ type: "text", text: "ok" }]],
          delayMs: 400,
        }),
        falseInterruptionTimeoutMs: 40,
        speechIdleTimeoutMs: 60,
      });
      const llm = opts.llm as ReturnType<typeof createFakeLanguageModel>;
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("where is my order");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });
      tts.last()?.fireAudio(new Int16Array(2400));

      // Noise partial → barge-in → the window elapses and the edge closes, so
      // the resume turn starts.
      stt.last()?.firePartial("uh what");
      await vi.waitFor(() => {
        expect(callbacks.onReplyStarted).toHaveBeenCalledTimes(2);
      });

      // The caller's real turn commits, mooting the still-silent resume.
      expect(callbacks.onAudioChunk).toHaveBeenCalledTimes(1); // turn 1's only
      stt.last()?.fireFinal("actually where is my refund");
      await vi.waitFor(() => {
        expect(callbacks.onUserTranscript).toHaveBeenCalledWith("actually where is my refund");
      });
      await vi.waitFor(() => {
        if (llm.calls.length < 3) throw new Error("mooted resume's replacement turn not started");
      });

      const request = JSON.stringify(llm.calls.at(-1));
      expect(request).toContain("actually where is my refund");
      expect(request).not.toContain("did not actually say anything");
      await t.stop();
    });

    test("client-initiated cancelReply never resumes", async () => {
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script, delayMs: 20 }),
        falseInterruptionTimeoutMs: 40,
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("where is my order");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });
      // Barge-in requires the agent to be audibly speaking, not merely mid-turn.
      tts.last()?.fireAudio(new Int16Array(2400));

      t.cancelReply();
      await new Promise((r) => setTimeout(r, 80));
      expect(callbacks.onReplyStarted).toHaveBeenCalledTimes(1);
      await t.stop();
    });
  });

  describe("holdPhrase configuration", () => {
    const toolFirstScript: ScriptedPart[] = [
      { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: "{}" },
    ];

    test("a custom holdPhrase is spoken when the turn opens with a tool call", async () => {
      const { opts, stt, tts } = makeOpts({
        llm: createFakeLanguageModel({
          steps: [toolFirstScript, [{ type: "text", text: "Done." }]],
        }),
        holdPhrase: "Un momento.",
        toolSchemas: [noopToolSchema],
        executeTool: async () => "{}",
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("look it up");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.join("")).toContain("Un momento.");
      });
      await tick();
      await t.stop();
    });

    test("holdPhrase '' disables the filler entirely", async () => {
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({
          steps: [toolFirstScript, [{ type: "text", text: "Done." }]],
        }),
        holdPhrase: "",
        toolSchemas: [noopToolSchema],
        executeTool: async () => "{}",
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("look it up");
      await vi.waitFor(() => {
        expect(callbacks.onReplyDone).toHaveBeenCalled();
      });
      expect(tts.last()?.textChunks.join("")).not.toContain("One moment");
      await t.stop();
    });
  });
});
