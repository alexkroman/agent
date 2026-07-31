// Copyright 2026 the AAI authors. MIT license.
/**
 * What the pipeline transport says outside a model turn, and what it records.
 *
 * Two cases sharing one question — is this speech, or is it plumbing? The hold
 * phrase and dead-air cover are audible but must not enter the conversation
 * record; the interim transcript must reach the client as the words become
 * audible rather than all at once when the reply ends.
 *
 * Split out of `pipeline-transport.test.ts` for file length.
 */

import { describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel, type ScriptedPart } from "../_pipeline-test-fakes.ts";
import { makeOpts, noopToolSchema, partialTranscriptSpy } from "./_pipeline-transport-harness.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";

describe("PipelineTransport speech vs. record", () => {
  describe("interim agent transcript", () => {
    test("publishes the hold phrase before the model's answer exists", async () => {
      // A reply that opens with a tool call speaks its hold phrase seconds (or,
      // on a long chain, minutes) before `onAgentTranscript` fires with the
      // whole reply. A client that pairs text with audio has played that audio
      // by then, so the words have to go out when they become audible.
      const script: ScriptedPart[] = [
        {
          type: "tool-call",
          toolCallId: "tc-1",
          toolName: "get_weather",
          input: JSON.stringify({ city: "SF" }),
        },
        { type: "tool-result", toolCallId: "tc-1", toolName: "get_weather", result: "sunny" },
        { type: "text", text: "It's sunny." },
      ];
      const { opts, stt, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script }),
        holdPhrase: "One moment.",
        executeTool: vi.fn(async () => "sunny"),
        toolSchemas: [{ ...noopToolSchema, name: "get_weather" }],
      });
      const t = createPipelineTransport(opts);
      await t.start();
      stt.last()?.fireFinal("how's the weather?");

      await vi.waitFor(() => {
        expect(callbacks.onAgentTranscriptPartial).toHaveBeenCalledWith("One moment.");
      });
      // Still cumulative, and still one final transcript for history.
      await vi.waitFor(() => {
        expect(callbacks.onAgentTranscript).toHaveBeenCalledWith(
          expect.stringContaining("It's sunny."),
          false,
        );
      });
      const lastPartial = partialTranscriptSpy(callbacks).mock.lastCall?.[0];
      expect(lastPartial).toContain("One moment.");
      expect(lastPartial).toContain("It's sunny.");
      await t.stop();
    });

    test("starts each reply's transcript from empty", async () => {
      const { opts, stt, callbacks } = makeOpts({
        sessionConfig: { systemPrompt: "s", greeting: "Hi there!" },
        llm: createFakeLanguageModel({ script: [{ type: "text", text: "It is three." }] }),
      });
      const t = createPipelineTransport(opts);
      await t.start();
      await vi.waitFor(() => {
        expect(callbacks.onAgentTranscriptPartial).toHaveBeenCalledWith("Hi there!");
      });
      partialTranscriptSpy(callbacks).mockClear();

      stt.last()?.fireFinal("what time is it?");
      await vi.waitFor(() => {
        expect(callbacks.onAgentTranscriptPartial).toHaveBeenCalled();
      });
      // Carrying the previous reply's text over would restate the greeting as
      // part of this reply's caption.
      for (const [text] of partialTranscriptSpy(callbacks).mock.calls) {
        expect(text).not.toContain("Hi there!");
      }
      await t.stop();
    });
  });

  describe("filler is spoken but not recorded", () => {
    test("the hold phrase reaches TTS but not the recorded transcript", async () => {
      // "One moment." is a timing artifact, not something the agent said. Left in
      // the record it costs context on every later turn and shows the model its
      // own filler as an example of what its turns look like.
      const script: ScriptedPart[] = [
        {
          type: "tool-call",
          toolCallId: "tc-1",
          toolName: "get_weather",
          input: JSON.stringify({ city: "SF" }),
        },
        { type: "tool-result", toolCallId: "tc-1", toolName: "get_weather", result: "sunny" },
        { type: "text", text: "It's sunny." },
      ];
      const { opts, stt, tts, callbacks } = makeOpts({
        llm: createFakeLanguageModel({ script }),
        holdPhrase: "One moment.",
        executeTool: vi.fn(async () => "sunny"),
        toolSchemas: [{ ...noopToolSchema, name: "get_weather" }],
      });
      const t = createPipelineTransport(opts);
      await t.start();
      stt.last()?.fireFinal("how's the weather?");

      await vi.waitFor(() => {
        expect(callbacks.onReplyDone).toHaveBeenCalled();
      });
      // Heard by the caller...
      expect(tts.last()?.textChunks.join("")).toContain("One moment.");
      // ...and shown live, since the caption is built from what reaches TTS.
      expect(
        partialTranscriptSpy(callbacks).mock.calls.some(([text]) => text.includes("One moment")),
      ).toBe(true);
      // ...but absent from the reply's final transcript, which is what history,
      // ctx.messages, resume, and the STT agent-context hint are built from.
      const finals = vi
        .mocked(callbacks.onAgentTranscript)
        .mock.calls.filter(([, interrupted]) => interrupted === false)
        .map(([text]) => text);
      expect(finals.some((text) => text.includes("It's sunny."))).toBe(true);
      for (const text of finals) expect(text).not.toContain("One moment.");
      await t.stop();
    });
  });
});
