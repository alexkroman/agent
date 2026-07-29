// Copyright 2026 the AAI authors. MIT license.
// One-shot uploaded-clip transcription in the pipeline transport: AssemblyAI
// STT routes the clip through the Sync API and runs the transcript as a
// user turn; other providers fall back to replaying through their realtime
// socket; failures surface as turn-level errors, not session teardowns.

import { describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel, createFakeSttProvider } from "../_pipeline-test-fakes.ts";
import { makeOpts } from "./_pipeline-transport-harness.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";

type FetchArgs = [input: string | URL | Request, init?: RequestInit];

function syncApiMock(response: () => Response) {
  const fn = vi.fn(async (..._args: FetchArgs) => response());
  return fn as unknown as typeof globalThis.fetch & { mock: { calls: FetchArgs[] } };
}

const transcriptResponse = (text: string) => () =>
  new Response(JSON.stringify({ text, words: [] }), { status: 200 });

/** An STT fake whose opener reports the assemblyai kind (sync-capable). */
function assemblyAiStt() {
  const fake = createFakeSttProvider();
  return { ...fake, name: "assemblyai" };
}

const CLIP = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]);

describe("PipelineTransport.transcribeFile", () => {
  test("AssemblyAI STT: transcribes via the Sync API and runs the turn", async () => {
    const fetchFn = syncApiMock(transcriptResponse("summarize this please"));
    const stt = assemblyAiStt();
    const { opts, callbacks } = makeOpts({
      stt,
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "Summary: done." }] }),
      providerKeys: { stt: "aai-key" },
      fetch: fetchFn,
    });
    const t = createPipelineTransport(opts);
    await t.start();
    t.transcribeFile?.(CLIP, 16_000);
    await vi.waitFor(() => {
      expect(callbacks.onReplyDone).toHaveBeenCalled();
    });
    // The whole clip went out as one sync request, not through the socket.
    expect(fetchFn).toHaveBeenCalledOnce();
    const [, init] = fetchFn.mock.calls[0] ?? [];
    const form = init?.body as FormData;
    expect((form.get("audio") as Blob).size).toBe(CLIP.byteLength);
    expect(JSON.parse(form.get("config") as string)).toEqual({ sample_rate: 16_000, channels: 1 });
    expect(init?.headers).toMatchObject({ Authorization: "aai-key" });
    expect(callbacks.onUserTranscript).toHaveBeenCalledWith("summarize this please");
    expect(callbacks.onAgentTranscript).toHaveBeenCalledWith("Summary: done.", false);
    await t.stop();
  });

  test("non-AssemblyAI STT: falls back to replaying through the realtime socket", async () => {
    const fetchFn = syncApiMock(transcriptResponse("never used"));
    const { opts, stt } = makeOpts({ fetch: fetchFn });
    const t = createPipelineTransport(opts);
    await t.start();
    t.transcribeFile?.(CLIP, 16_000);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(stt.last()?.sendAudio).toHaveBeenCalledOnce();
    await t.stop();
  });

  test("a failed sync transcription emits an stt error without tearing the session down", async () => {
    const fetchFn = syncApiMock(
      () => new Response(JSON.stringify({ message: "audio too short" }), { status: 400 }),
    );
    const stt = assemblyAiStt();
    const { opts, callbacks } = makeOpts({ stt, providerKeys: { stt: "k" }, fetch: fetchFn });
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
    const fetchFn = syncApiMock(transcriptResponse("   "));
    const stt = assemblyAiStt();
    const { opts, callbacks } = makeOpts({ stt, providerKeys: { stt: "k" }, fetch: fetchFn });
    const t = createPipelineTransport(opts);
    await t.start();
    t.transcribeFile?.(CLIP, 16_000);
    await vi.waitFor(() => {
      expect(fetchFn).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(callbacks.onUserTranscript).not.toHaveBeenCalled();
    expect(callbacks.onReplyStarted).not.toHaveBeenCalled();
    await t.stop();
  });
});
