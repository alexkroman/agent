// Copyright 2026 the AAI authors. MIT license.
// One-shot uploaded-clip transcription in the pipeline transport: an STT
// opener with a batch capability (`transcribeClip`, e.g. AssemblyAI's Sync
// API) transcribes the clip in one request and runs the transcript as a
// user turn; providers without one get the clip replayed through their
// realtime socket; failures surface as turn-level errors, not teardowns.

import { describe, expect, test, vi } from "vitest";
import type { SttOpener, TranscribeClipOptions } from "../../sdk/providers.ts";
import { createFakeLanguageModel, createFakeSttProvider } from "../_pipeline-test-fakes.ts";
import { makeOpts } from "./_pipeline-transport-harness.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";

/** An STT fake with a one-shot batch capability (like AssemblyAI's Sync API). */
function clipCapableStt(transcribeClip: NonNullable<SttOpener["transcribeClip"]>) {
  return { ...createFakeSttProvider(), transcribeClip };
}

const CLIP = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]);

describe("PipelineTransport.transcribeFile", () => {
  test("a clip-capable provider transcribes one-shot and runs the turn", async () => {
    const transcribeClip = vi.fn(async () => "summarize this please");
    const { opts, callbacks } = makeOpts({
      stt: clipCapableStt(transcribeClip),
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "Summary: done." }] }),
      providerKeys: { stt: "aai-key" },
    });
    const t = createPipelineTransport(opts);
    await t.start();
    t.transcribeFile?.(CLIP, 16_000);
    await vi.waitFor(() => {
      expect(callbacks.onReplyDone).toHaveBeenCalled();
    });
    expect(transcribeClip).toHaveBeenCalledOnce();
    const [pcm, sampleRate, clipOpts] = transcribeClip.mock.calls[0] as unknown as [
      Uint8Array,
      number,
      TranscribeClipOptions,
    ];
    expect(pcm).toBe(CLIP);
    expect(sampleRate).toBe(16_000);
    expect(clipOpts.apiKey).toBe("aai-key");
    expect(callbacks.onUserTranscript).toHaveBeenCalledWith("summarize this please");
    expect(callbacks.onAgentTranscript).toHaveBeenCalledWith("Summary: done.", false);
    await t.stop();
  });

  test("a provider without the capability gets the clip replayed with endpointing padding", async () => {
    const { opts, stt } = makeOpts();
    const t = createPipelineTransport(opts);
    await t.start();
    t.transcribeFile?.(CLIP, 16_000);
    const sendAudio = stt.last()?.sendAudio as ReturnType<typeof vi.fn>;
    expect(sendAudio).toHaveBeenCalled();
    const totalSamples = sendAudio.mock.calls.reduce(
      (n: number, call: unknown[]) => n + (call[0] as Int16Array).length,
      0,
    );
    // The clip's 4 samples plus one second of silence at 16 kHz.
    expect(totalSamples).toBe(CLIP.byteLength / 2 + 16_000);
    await t.stop();
  });

  test("a failed transcription emits an stt error without tearing the session down", async () => {
    const transcribeClip = vi.fn(async () => {
      throw new Error("Sync transcription failed: HTTP 400 (audio too short)");
    });
    const { opts, callbacks } = makeOpts({
      stt: clipCapableStt(transcribeClip),
      providerKeys: { stt: "k" },
    });
    const t = createPipelineTransport(opts);
    await t.start();
    t.transcribeFile?.(CLIP, 16_000);
    await vi.waitFor(() => {
      expect(callbacks.onError).toHaveBeenCalledWith("stt", expect.stringContaining("HTTP 400"));
    });
    // Not terminated: live mic audio still flows.
    t.sendUserAudio(new Uint8Array([1, 2]));
    expect(callbacks.onCancelled).not.toHaveBeenCalled();
    await t.stop();
  });

  test("an empty transcript runs no turn", async () => {
    const transcribeClip = vi.fn(async () => "   ");
    const { opts, callbacks } = makeOpts({
      stt: clipCapableStt(transcribeClip),
      providerKeys: { stt: "k" },
    });
    const t = createPipelineTransport(opts);
    await t.start();
    t.transcribeFile?.(CLIP, 16_000);
    await vi.waitFor(() => {
      expect(transcribeClip).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(callbacks.onUserTranscript).not.toHaveBeenCalled();
    expect(callbacks.onReplyStarted).not.toHaveBeenCalled();
    await t.stop();
  });
});
