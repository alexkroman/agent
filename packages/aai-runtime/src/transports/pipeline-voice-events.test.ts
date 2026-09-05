// Copyright 2026 the AAI authors. MIT license.
// Voice-UX event specs for the pipeline transport: user-speaking edge events
// (speech_started/speech_stopped derived from the STT transcript stream),
// interim-transcript forwarding, false-interruption recovery, and the
// dead-air cover's enable. Barge-in mechanics live in
// pipeline-transport-barge-in.test.ts; shared helpers in
// _pipeline-transport-harness.ts.

import { DEAD_AIR_OPENING_PHRASE, DEFAULT_DEAD_AIR_COVER_MS } from "@alexkroman1/aai/host-internal";
import { sleep } from "@alexkroman1/aai/internal";
import { describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel, type ScriptedPart } from "../_pipeline-test-fakes.ts";
import {
  inFlightReplyScript,
  llmCalls,
  makeOpts,
  noopToolSchema,
  useVirtualTime,
} from "./_pipeline-transport-harness.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";

useVirtualTime();

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
      expect(callbacks.reported("speech.started")).toHaveBeenCalledTimes(1);
      expect(callbacks.reported("speech.stopped")).not.toHaveBeenCalled();

      stt.last()?.fireFinal("hello there agent");
      await vi.waitFor(() => {
        expect(callbacks.reported("user-transcript.committed")).toHaveBeenCalledWith({
          type: "user-transcript.committed",
          text: "hello there agent",
        });
      });
      expect(callbacks.reported("speech.stopped")).toHaveBeenCalledTimes(1);
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
        expect(callbacks.reported("user-transcript.committed")).toHaveBeenCalledWith({
          type: "user-transcript.committed",
          text: "short utterance.",
        });
      });
      expect(callbacks.reported("speech.started")).toHaveBeenCalledTimes(1);
      expect(callbacks.reported("speech.stopped")).toHaveBeenCalledTimes(1);
      await t.stop();
    });

    // `speech_started` must mean the same thing on both transports: the user
    // took the floor and the agent is yielding. S2S gets that for free (the
    // service stops generating when it fires); pipeline mode derives the edge
    // from STT partials, so a sub-threshold noise would otherwise announce an
    // interruption that never happens. Clients act on it — tau2-bench discards
    // its entire agent playout buffer on this event and has no `cancelled`
    // handler — so a premature edge silences a reply that is still being
    // spoken. See createGatedSpeechEdges in pipeline-user-speech.ts.
    test("a sub-threshold partial over agent speech does NOT fire onSpeechStarted", async () => {
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script: inFlightReplyScript(), delayMs: 20 }),
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("hi there");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });
      tts.last()?.fireAudio(new Int16Array(2400)); // the turn has now SPOKEN
      vi.mocked(callbacks.reported("speech.started")).mockClear();

      // One word — below minBargeInWords, so the reply is correctly NOT
      // aborted. The client must not be told the agent yielded either.
      stt.last()?.firePartial("mm-hmm");
      expect(callbacks.reported("reply.cancelled")).not.toHaveBeenCalled();
      expect(callbacks.reported("speech.started")).not.toHaveBeenCalled();
      // Live captions are independent of the gate.
      expect(callbacks.reported("user-transcript.updated")).toHaveBeenCalledWith({
        type: "user-transcript.updated",
        text: "mm-hmm",
        eotConfidence: undefined,
      });
      await t.stop();
    });

    test("a barge-in over agent speech fires onSpeechStarted with the cancel", async () => {
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script: inFlightReplyScript(), delayMs: 20 }),
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("hi there");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });
      tts.last()?.fireAudio(new Int16Array(2400));
      vi.mocked(callbacks.reported("speech.started")).mockClear();

      stt.last()?.firePartial("wait stop"); // ≥ minBargeInWords → real barge-in
      expect(callbacks.reported("reply.cancelled")).toHaveBeenCalled();
      expect(callbacks.reported("speech.started")).toHaveBeenCalledTimes(1);
      await t.stop();
    });

    test("a held edge is released once the agent stops speaking on its own", async () => {
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script: [{ type: "text", text: "hi" }] }),
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("hi there");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });
      tts.last()?.fireAudio(new Int16Array(2400));
      await vi.waitFor(() => {
        expect(callbacks.reported("reply.completed")).toHaveBeenCalled();
      });
      vi.mocked(callbacks.reported("speech.started")).mockClear();

      // Held while the reply drains, then released on the next partial once
      // there is no floor left to protect — the user is speaking into silence.
      stt.last()?.firePartial("one");
      stt.last()?.firePartial("one more");
      expect(callbacks.reported("speech.started")).toHaveBeenCalledTimes(1);
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
      // No `eotConfidence` key at all when the provider reported none — absent
      // means "no opinion", never zero, and `omitUndefined` is what keeps that
      // true on the wire.
      expect(callbacks.reported("user-transcript.updated")).toHaveBeenNthCalledWith(1, {
        type: "user-transcript.updated",
        text: "track my",
      });
      expect(callbacks.reported("user-transcript.updated")).toHaveBeenNthCalledWith(2, {
        type: "user-transcript.updated",
        text: "track my order",
      });
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
      expect(callbacks.reported("speech.started")).not.toHaveBeenCalled();
      expect(callbacks.reported("user-transcript.updated")).not.toHaveBeenCalled();
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
        // The speaking edge going idle (the noise partial opens it and no
        // final ever arrives) IS the resume — shortened here to keep the spec
        // inside vi.waitFor's window. Every spec in this describe sets it,
        // including the ones asserting NO resume: at the shipped 3500 nothing
        // could resume inside their sleep, so they would pass vacuously.
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
      expect(callbacks.reported("reply.cancelled")).toHaveBeenCalled();

      // The edge goes idle with no committed turn → resume turn runs.
      await vi.waitFor(() => {
        expect(callbacks.onReplyStarted).toHaveBeenCalledTimes(2);
      });
      await vi.waitFor(() => {
        expect(callbacks.reported("agent-transcript.committed")).toHaveBeenCalledWith({
          type: "agent-transcript.committed",
          text: "As I was saying…",
        });
      });
      // The synthetic continuation prompt is never surfaced as a user transcript.
      expect(callbacks.reported("user-transcript.committed")).toHaveBeenCalledTimes(1);
      // The unresolved speaking edge from the noise partial is closed out.
      expect(callbacks.reported("speech.stopped")).toHaveBeenCalled();
      await t.stop();
    });

    test("a final after the barge-in is a real turn — no resume fires", async () => {
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({
          steps: [script, [{ type: "text", text: "ok" }]],
          delayMs: 20,
        }),
        speechIdleTimeoutMs: 40,
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
      expect(callbacks.reported("reply.cancelled")).toHaveBeenCalled();
      stt.last()?.fireFinal("wait actually cancel it.");
      await vi.waitFor(() => {
        expect(callbacks.reported("user-transcript.committed")).toHaveBeenCalledWith({
          type: "user-transcript.committed",
          text: "wait actually cancel it.",
        });
      });

      // A stray sub-threshold partial afterwards opens a fresh speaking edge
      // and lets it go idle — the one thing that fires a resume. The latch has
      // no self-expiry, so this is what proves the committed final consumed it
      // rather than leaving it to fire against an unrelated utterance.
      stt.last()?.firePartial("hm");
      await vi.advanceTimersByTimeAsync(120);
      expect(callbacks.onReplyStarted).toHaveBeenCalledTimes(2);
      await t.stop();
    });

    test("resumeFalseInterruption false arms nothing", async () => {
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script, delayMs: 20 }),
        resumeFalseInterruption: false,
        // Short enough that a resume would have fired well inside the sleep
        // below if anything had been armed.
        speechIdleTimeoutMs: 40,
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
      expect(callbacks.reported("reply.cancelled")).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(120);
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
        speechIdleTimeoutMs: 60,
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("count down from 20");
      await vi.waitFor(() => {
        expect(callbacks.reported("reply.completed")).toHaveBeenCalled();
      });

      // 10 s of PCM16 at the default 24 kHz — client playback lags well behind.
      tts.last()?.fireAudio(new Int16Array(240_000));
      stt.last()?.firePartial("uh what");
      expect(callbacks.reported("reply.cancelled")).toHaveBeenCalled();

      // The edge goes idle with no committed turn → the reply resumes.
      await vi.waitFor(() => {
        expect(callbacks.onReplyStarted).toHaveBeenCalledTimes(2);
      });
      await vi.waitFor(() => {
        expect(callbacks.reported("agent-transcript.committed")).toHaveBeenCalledWith({
          type: "agent-transcript.committed",
          text: "As I was counting…",
        });
      });
      // The resume turn's synthetic prompt tells the model about the cut; it
      // is never surfaced as a user transcript.
      expect(JSON.stringify(llm.calls.at(-1))).toContain("cut off by a false interruption");
      expect(callbacks.reported("user-transcript.committed")).toHaveBeenCalledTimes(1);
      await t.stop();
    });

    test("a barge-in on a playback tail the caller has essentially heard does not resume", async () => {
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script: [{ type: "text", text: "Sure." }] }),
        // Short: at the shipped 3500 nothing could resume inside the sleep
        // below, so this spec would pass without arming anything. Proven —
        // raising the audio to 10s (which DOES arm a tail prompt) still passed.
        speechIdleTimeoutMs: 40,
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("thanks");
      await vi.waitFor(() => {
        expect(callbacks.reported("reply.completed")).toHaveBeenCalled();
      });

      // 500 ms of audio — under TAIL_RESUME_MIN_UNHEARD_MS, so the cut costs
      // nothing worth a resume turn (which would only append a fragment to a
      // reply the caller heard).
      tts.last()?.fireAudio(new Int16Array(12_000));
      stt.last()?.firePartial("uh what");
      expect(callbacks.reported("reply.cancelled")).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(120);
      expect(callbacks.onReplyStarted).toHaveBeenCalledTimes(1);
      await t.stop();
    });

    test("a user who keeps talking is not resumed over — partials restart the watchdog", async () => {
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({
          steps: [script, [{ type: "text", text: "As I was saying…" }]],
          delayMs: 20,
        }),
        // Longer than the ~25 ms between the partials below (so a watchdog
        // that restarts never fires) but well under their ~125 ms total (so
        // one that failed to restart would resume over the caller).
        speechIdleTimeoutMs: 80,
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("where is my order");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });
      // Barge-in requires the agent to be audibly speaking, not merely mid-turn.
      tts.last()?.fireAudio(new Int16Array(2400));

      // Barge in, then keep speaking well past the resume deadline. Providers
      // that only emit a final at end-of-turn (AssemblyAI) produce exactly this
      // shape: a long run of partials with no final in sight.
      stt.last()?.firePartial("wait actually");
      expect(callbacks.reported("reply.cancelled")).toHaveBeenCalled();
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(25);
        stt.last()?.firePartial(`wait actually hold on ${i}`);
      }

      // ~125 ms > the 80 ms deadline, but the agent must not have resumed
      // over them: every partial restarts the watchdog that fires the resume.
      expect(callbacks.onReplyStarted).toHaveBeenCalledTimes(1);

      // The utterance finally commits as the real turn it always was.
      stt.last()?.fireFinal("wait actually hold on, cancel it.");
      await vi.waitFor(() => {
        expect(callbacks.reported("user-transcript.committed")).toHaveBeenCalledWith({
          type: "user-transcript.committed",
          text: "wait actually hold on, cancel it.",
        });
      });
      await t.stop();
    });

    test("a barge-in partial's caption survives the cancel that follows it", async () => {
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script, delayMs: 20 }),
        resumeFalseInterruption: false,
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
      const partialCall = callbacks.reported("user-transcript.updated").mock.invocationCallOrder[0];
      const cancelledCall = callbacks.reported("reply.cancelled").mock.invocationCallOrder[0];
      expect(partialCall).toBeGreaterThan(cancelledCall as number);
      await t.stop();
    });

    test("a final-triggered barge-in re-emits the caption after the cancel", async () => {
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script, delayMs: 20 }),
        resumeFalseInterruption: false,
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
      expect(callbacks.reported("reply.cancelled")).toHaveBeenCalled();
      const cancelledCall = callbacks.reported("reply.cancelled").mock.invocationCallOrder[0];
      const transcriptCalls = callbacks.reported("user-transcript.committed").mock;
      const idx = transcriptCalls.calls.findIndex(
        (c) => (c[0] as { text?: string }).text === "okay, cool.",
      );
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
        speechIdleTimeoutMs: 60,
      });
      const llm = llmCalls(opts);
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("where is my order");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });
      tts.last()?.fireAudio(new Int16Array(2400));

      // Noise partial → barge-in → the edge goes idle, so the resume starts.
      stt.last()?.firePartial("uh what");
      await vi.waitFor(() => {
        expect(callbacks.onReplyStarted).toHaveBeenCalledTimes(2);
      });

      // The caller's real turn commits, mooting the still-silent resume.
      expect(callbacks.onAudioChunk).toHaveBeenCalledTimes(1); // turn 1's only
      stt.last()?.fireFinal("actually where is my refund");
      await vi.waitFor(() => {
        expect(callbacks.reported("user-transcript.committed")).toHaveBeenCalledWith({
          type: "user-transcript.committed",
          text: "actually where is my refund",
        });
      });
      await vi.waitFor(() => {
        if (llm.calls.length < 3) throw new Error("mooted resume's replacement turn not started");
      });

      const request = JSON.stringify(llm.calls.at(-1));
      expect(request).toContain("actually where is my refund");
      expect(request).not.toContain("did not actually say anything");
      await t.stop();
    });

    test("a resume that generated text but played none leaves NO trace at all", async () => {
      // The trace the truthful-truncation rule turns on. The resume turn
      // produced words, the caller heard none of them (no audio ever reached
      // the ear), so no assistant message is written — and its synthetic
      // prompt must therefore be rolled back too. Left standing, "the user did
      // not actually say anything…" sits unanswered directly ahead of the next
      // real user turn: the two-contradictory-user-messages failure again.
      // The resume's own script cannot finish on its own either: the cut has
      // to land while it is still streaming, which is the only window
      // persistBargeIn runs in (a turn that COMPLETES commits its full text —
      // the drain case, deliberately out of scope).
      const resumeScript: ScriptedPart[] = Array.from({ length: 100 }, (_, i) => ({
        type: "text",
        text: `resumed${i} `,
      }));
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({
          steps: [script, resumeScript, [{ type: "text", text: "ok" }]],
          delayMs: 20,
        }),
        speechIdleTimeoutMs: 60,
      });
      const llm = llmCalls(opts);
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("where is my order");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });
      tts.last()?.fireAudio(new Int16Array(2400));
      stt.last()?.firePartial("uh what");

      // The resume runs and streams text into TTS — but no audio is forwarded
      // for it, so nothing of it was ever audible.
      await vi.waitFor(() => {
        expect(callbacks.onReplyStarted).toHaveBeenCalledTimes(2);
      });
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.join("")).toContain("resumed0");
      });
      t.cancelReply();

      stt.last()?.fireFinal("never mind then");
      await vi.waitFor(() => {
        expect(callbacks.reported("user-transcript.committed")).toHaveBeenCalledWith({
          type: "user-transcript.committed",
          text: "never mind then",
        });
      });
      await vi.waitFor(() => {
        if (llm.calls.length < 3) throw new Error("follow-up turn not started");
      });

      const request = JSON.stringify(llm.calls.at(-1));
      expect(request).toContain("never mind then");
      expect(request).not.toContain("resumed");
      expect(request).not.toContain("did not actually say anything");
      await t.stop();
    });

    test("client-initiated cancelReply discards an armed resume", async () => {
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script, delayMs: 20 }),
        speechIdleTimeoutMs: 40,
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("where is my order");
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.length).toBeGreaterThan(0);
      });
      // Barge-in requires the agent to be audibly speaking, not merely mid-turn.
      tts.last()?.fireAudio(new Int16Array(2400));

      // Barge in first, so a resume IS armed and the cancel has something to
      // discard — the version of this spec that only called cancelReply could
      // not fail, since nothing was ever armed.
      stt.last()?.firePartial("uh what");
      expect(callbacks.reported("reply.cancelled")).toHaveBeenCalled();
      t.cancelReply();

      // The noise partial's speaking edge now goes idle, which is what would
      // fire the resume. A client-initiated cancel is intentional: it doesn't.
      await vi.advanceTimersByTimeAsync(120);
      expect(callbacks.onReplyStarted).toHaveBeenCalledTimes(1);
      await t.stop();
    });
  });

  describe("deadAirCoverMs configuration", () => {
    const toolFirstScript: ScriptedPart[] = [
      { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: "{}" },
    ];

    test("a silent turn draws the cover filler through the whole transport", async () => {
      const { opts, stt, tts } = makeOpts({
        llm: createFakeLanguageModel({
          steps: [toolFirstScript, [{ type: "text", text: "Done." }]],
          delayMs: 20,
        }),
        // The SHIPPED window, not a 1ms stand-in for it. On the wall clock this
        // spec could only afford `deadAirCoverMs: 1`, which tests the wiring
        // and says nothing about the default a caller actually waits out.
        deadAirCoverMs: DEFAULT_DEAD_AIR_COVER_MS,
        toolSchemas: [noopToolSchema],
        // A tool that outlasts the cover window — which is the only shape that
        // produces dead air at the shipped 5s. The measured case this exists
        // for is a 15-24s tool chain; on the wall clock the spec could afford
        // neither, so it shrank the WINDOW to 1ms instead and tested the wiring
        // against a turn that was never silent.
        executeTool: async () => {
          await sleep(DEFAULT_DEAD_AIR_COVER_MS * 2);
          return "{}";
        },
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("look it up");
      // Armed, but the window has not elapsed: the caller is in an ordinary
      // pause, and covering it here would cost the reply's opening sentence.
      await vi.advanceTimersByTimeAsync(DEFAULT_DEAD_AIR_COVER_MS - 1);
      expect(tts.last()?.textChunks.join("")).not.toContain(DEAD_AIR_OPENING_PHRASE);

      await vi.advanceTimersByTimeAsync(1);
      expect(tts.last()?.textChunks.join("")).toContain(DEAD_AIR_OPENING_PHRASE);

      // The tool lands and the reply follows it.
      await vi.advanceTimersByTimeAsync(DEFAULT_DEAD_AIR_COVER_MS * 2);
      await vi.waitFor(() => {
        expect(tts.last()?.textChunks.join("")).toContain("Done.");
      });
      await t.stop();
    });

    test("deadAirCoverMs 0 disables the filler entirely", async () => {
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({
          steps: [toolFirstScript, [{ type: "text", text: "Done." }]],
          delayMs: 20,
        }),
        deadAirCoverMs: 0,
        toolSchemas: [noopToolSchema],
        executeTool: async () => "{}",
      });
      const t = createPipelineTransport(opts);
      await t.start();

      stt.last()?.fireFinal("look it up");
      await vi.waitFor(() => {
        expect(callbacks.reported("reply.completed")).toHaveBeenCalled();
      });
      expect(tts.last()?.textChunks.join("")).toBe("Done.");
      await t.stop();
    });
  });
});
