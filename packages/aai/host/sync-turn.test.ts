// Copyright 2026 the AAI authors. MIT license.
// Sync-turn runner: transcription, LLM loop, one-shot synthesis, and the
// error statuses each stage maps to.

import { describe, expect, test, vi } from "vitest";
import { DEFAULT_MAX_HISTORY } from "../sdk/constants.ts";
import type { SttOpener, TtsOpener } from "../sdk/providers.ts";
import type { SyncTurnRequest } from "../sdk/sync.ts";
import { base64ToUint8, uint8ToBase64 } from "./_base64.ts";
import { createFakeLanguageModel, type ScriptedPart } from "./_pipeline-test-fakes.ts";
import { makeConfig, silentLogger } from "./_test-utils.ts";
import { createSyncTurnRunner, type SyncTurnDeps, SyncTurnError } from "./sync-turn.ts";

const STT_ENV = "FAKE_STT_KEY";
const TTS_ENV = "FAKE_TTS_KEY";

function makeDeps(
  overrides: Partial<SyncTurnDeps> & {
    script?: ScriptedPart[][];
    transcribeClip?: SttOpener["transcribeClip"];
    synthesizeClip?: TtsOpener["synthesizeClip"];
    noTts?: boolean;
  } = {},
): SyncTurnDeps {
  const stt: SttOpener = {
    name: "fake-stt",
    open: () => Promise.reject(new Error("streaming open must not be used")),
    ...(overrides.transcribeClip ? { transcribeClip: overrides.transcribeClip } : {}),
  };
  const tts: TtsOpener = {
    name: "fake-tts",
    open: () => Promise.reject(new Error("streaming open must not be used")),
    ...(overrides.synthesizeClip ? { synthesizeClip: overrides.synthesizeClip } : {}),
  };
  const llm = createFakeLanguageModel({
    steps: overrides.script ?? [[{ type: "text", text: "Hi there!" }]],
  });
  return {
    agentConfig: makeConfig(),
    providers: {
      stt: { opener: stt, envVar: STT_ENV },
      llm,
      tts: overrides.noTts ? null : { opener: tts, envVar: TTS_ENV },
    },
    env: { [STT_ENV]: "stt-key", [TTS_ENV]: "tts-key" },
    toolSchemas: [],
    executeTool: vi.fn(async () => "{}"),
    systemPrompt: () => "system prompt",
    ttsSampleRate: 24_000,
    logger: silentLogger,
    ...overrides,
  };
}

function textReq(overrides: Partial<SyncTurnRequest> = {}): SyncTurnRequest {
  return { text: "hello", history: [], ...overrides };
}

describe("createSyncTurnRunner", () => {
  test("text request: echoes transcript, returns the LLM reply", async () => {
    const run = createSyncTurnRunner(makeDeps());
    const res = await run(textReq());
    expect(res.transcript).toBe("hello");
    expect(res.reply).toBe("Hi there!");
  });

  test("synthesizes the reply via synthesizeClip with the TTS credential", async () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const synthesizeClip = vi.fn(async () => pcm);
    const run = createSyncTurnRunner(makeDeps({ synthesizeClip }));
    const res = await run(textReq());
    expect(res.audio).toBe(uint8ToBase64(pcm));
    expect(res.sampleRate).toBe(24_000);
    expect(res.ttsError).toBeUndefined();
    expect(synthesizeClip).toHaveBeenCalledWith(
      "Hi there!",
      expect.objectContaining({ apiKey: "tts-key", sampleRate: 24_000 }),
    );
  });

  test("TTS provider without synthesizeClip yields a text-only reply", async () => {
    const res = await createSyncTurnRunner(makeDeps())(textReq());
    expect(res.audio).toBeUndefined();
    expect(res.sampleRate).toBeUndefined();
    expect(res.ttsError).toBeUndefined();
  });

  test("text-only agent (tts null) yields a text-only reply", async () => {
    const res = await createSyncTurnRunner(makeDeps({ noTts: true }))(textReq());
    expect(res.reply).toBe("Hi there!");
    expect(res.audio).toBeUndefined();
  });

  test("synthesis failure degrades to ttsError, keeping the reply", async () => {
    const synthesizeClip = vi.fn(async () => {
      throw new Error("out of credits");
    });
    const res = await createSyncTurnRunner(makeDeps({ synthesizeClip }))(textReq());
    expect(res.reply).toBe("Hi there!");
    expect(res.audio).toBeUndefined();
    expect(res.ttsError).toContain("out of credits");
  });

  test("audio request: transcribes via transcribeClip with the STT credential", async () => {
    const transcribeClip = vi.fn(async () => "  spoken words  ");
    const run = createSyncTurnRunner(makeDeps({ transcribeClip }));
    const pcm = new Uint8Array([9, 8, 7, 6]);
    const res = await run({ audio: uint8ToBase64(pcm), sampleRate: 16_000, history: [] });
    expect(res.transcript).toBe("spoken words");
    const [gotPcm, gotRate, gotOpts] = transcribeClip.mock.calls[0] as unknown as [
      Uint8Array,
      number,
      { apiKey: string },
    ];
    expect([...gotPcm]).toEqual([...pcm]);
    expect(gotRate).toBe(16_000);
    expect(gotOpts.apiKey).toBe("stt-key");
  });

  test("audio request without a batch STT capability → 422", async () => {
    const run = createSyncTurnRunner(makeDeps());
    await expect(
      run({ audio: uint8ToBase64(new Uint8Array([1, 2])), sampleRate: 16_000, history: [] }),
    ).rejects.toMatchObject({ status: 422, name: "SyncTurnError" });
  });

  test("transcription failure → 502, message included, key withheld", async () => {
    const transcribeClip = vi.fn(async () => {
      throw new Error("HTTP 401 (unauthorized)");
    });
    const run = createSyncTurnRunner(makeDeps({ transcribeClip }));
    const err = await run({
      audio: uint8ToBase64(new Uint8Array([1, 2])),
      sampleRate: 16_000,
      history: [],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncTurnError);
    expect((err as SyncTurnError).status).toBe(502);
    expect((err as SyncTurnError).message).toContain("unauthorized");
    expect((err as SyncTurnError).message).not.toContain("stt-key");
  });

  test("empty transcription → 422", async () => {
    const transcribeClip = vi.fn(async () => "   ");
    const run = createSyncTurnRunner(makeDeps({ transcribeClip }));
    await expect(
      run({ audio: uint8ToBase64(new Uint8Array([1, 2])), sampleRate: 16_000, history: [] }),
    ).rejects.toMatchObject({ status: 422 });
  });

  test("LLM stream error → 502", async () => {
    const run = createSyncTurnRunner(
      makeDeps({ script: [[{ type: "error", error: new Error("model down") }]] }),
    );
    await expect(run(textReq())).rejects.toMatchObject({ status: 502 });
  });

  test("runs tool calls through executeTool and continues to the final reply", async () => {
    const executeTool = vi.fn(async () => JSON.stringify({ ok: true }));
    const deps = makeDeps({
      executeTool,
      script: [
        [{ type: "tool-call", toolCallId: "c1", toolName: "lookup", input: "{}" }],
        [{ type: "text", text: "done" }],
      ],
      toolSchemas: [
        {
          type: "function",
          name: "lookup",
          description: "look something up",
          parameters: { type: "object", properties: {} },
        },
      ],
    });
    const res = await createSyncTurnRunner(deps)(textReq());
    expect(res.reply).toBe("done");
    expect(executeTool).toHaveBeenCalledWith(
      "lookup",
      {},
      expect.stringMatching(/^sync:/),
      expect.any(Array),
      expect.any(Object),
    );
  });

  test("replays client history to the model, trimmed to the window", async () => {
    const deps = makeDeps();
    const run = createSyncTurnRunner(deps);
    const history = Array.from({ length: DEFAULT_MAX_HISTORY + 50 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `turn ${i}`,
    }));
    await run(textReq({ history }));
    const llm = deps.providers.llm as ReturnType<typeof createFakeLanguageModel>;
    const prompt = llm.calls[0]?.prompt as { role: string; content: unknown }[];
    // system + trimmed history + the new user turn
    expect(prompt.length).toBe(1 + DEFAULT_MAX_HISTORY + 1);
    expect(prompt[0]?.role).toBe("system");
    expect(prompt.at(-1)?.role).toBe("user");
  });

  test("base64 round-trip helpers agree", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    expect([...base64ToUint8(uint8ToBase64(bytes))]).toEqual([...bytes]);
  });
});
