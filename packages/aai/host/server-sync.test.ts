// Copyright 2026 the AAI authors. MIT license.
// POST /sync end-to-end over real HTTP: a pipeline runtime built from
// registered fake providers, driven through createServer.

import { afterEach, describe, expect, test } from "vitest";
import {
  createFakeLanguageModel,
  createFakeSttProvider,
  createFakeTtsProvider,
  registerFakeProviders,
} from "./_pipeline-test-fakes.ts";
import { makeAgent, silentLogger } from "./_test-utils.ts";
import { createRuntime } from "./runtime.ts";
import { createServer } from "./server.ts";

describe("POST /sync", () => {
  let server: ReturnType<typeof createServer> | null = null;
  let unregister: (() => void) | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
    unregister?.();
    unregister = null;
  });

  async function startPipelineServer(): Promise<string> {
    const fakes = registerFakeProviders({
      stt: createFakeSttProvider(),
      tts: createFakeTtsProvider(),
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "Hello from sync!" }] }),
    });
    unregister = fakes.unregister;
    const { stt, llm, tts } = fakes;
    if (!(stt && llm && tts)) throw new Error("fake descriptors missing");
    const runtime = createRuntime({
      agent: makeAgent({ stt, llm, tts }),
      env: fakes.env,
      logger: silentLogger,
    });
    server = createServer({ runtime, logger: silentLogger });
    await server.listen(0);
    return `http://127.0.0.1:${server.port}/sync`;
  }

  async function post(url: string, body: unknown): Promise<Response> {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  test("text turn answers 200 with transcript and reply", async () => {
    const url = await startPipelineServer();
    const res = await post(url, { text: "hi", history: [] });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { transcript: string; reply: string; audio?: string };
    expect(json.transcript).toBe("hi");
    expect(json.reply).toBe("Hello from sync!");
    // The fake TTS provider has no one-shot synthesis — text-only reply.
    expect(json.audio).toBeUndefined();
  });

  test("audio turn without batch STT answers 422", async () => {
    const url = await startPipelineServer();
    const res = await post(url, { audio: "AAECAw==", sampleRate: 16_000, history: [] });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("one-shot transcription");
  });

  test("malformed JSON answers 400", async () => {
    const url = await startPipelineServer();
    const res = await post(url, "{not json");
    expect(res.status).toBe(400);
  });

  test("schema violation answers 400 with the issue", async () => {
    const url = await startPipelineServer();
    const res = await post(url, { history: [] });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("exactly one of text or audio");
  });

  test("S2S-mode agent answers 409 (sync turns need the pipeline)", async () => {
    const runtime = createRuntime({ agent: makeAgent(), env: {}, logger: silentLogger });
    server = createServer({ runtime, logger: silentLogger });
    await server.listen(0);
    const res = await post(`http://127.0.0.1:${server.port}/sync`, { text: "hi", history: [] });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("pipeline mode");
  });
});
