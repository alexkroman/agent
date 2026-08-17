// Copyright 2026 the AAI authors. MIT license.
// The connect half of the AssemblyAI TTS adapter: which endpoint is dialed and
// what rides in the query string and the headers. Split out of
// `assemblyai.test.ts` (which owns the frame protocol) when that file reached
// its line cap — everything here is decided once, before the socket opens.

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AssemblyAITtsLanguage } from "../../../sdk/providers/tts/assemblyai.ts";
import { openSession } from "./_assemblyai-session-test-utils.ts";
import { FakeWebSocket } from "./_fake-ws-test-utils.ts";
import { openAssemblyAITts } from "./assemblyai.ts";

// Async factory importing an import-free module: the adapter's own "ws"
// import must not be reachable from the factory (it would re-enter the mock).
vi.mock("ws", async () => {
  const { FakeWebSocket } = await import("./_fake-ws-test-utils.ts");
  return { default: FakeWebSocket, WebSocket: FakeWebSocket };
});

beforeEach(() => {
  FakeWebSocket.reset();
});

describe("AssemblyAI TTS connect", () => {
  test("connects to the production streaming-TTS host with voice and sample rate", async () => {
    const { ws } = await openSession({ voice: "michael" });
    const url = new URL(ws.url);
    expect(url.host).toBe("streaming-tts.assemblyai.com");
    expect(url.pathname).toBe("/v1/ws/");
    expect(url.searchParams.get("voice")).toBe("michael");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
  });

  test("dials the cluster streamingUrl names, keeping its own query params", async () => {
    // A sandbox account is the same service behind another subdomain, handed out
    // as a URL — the same shape `assemblyAIStt({ streamingUrl })` takes, so
    // pointing both stages at one sandbox is two pastes rather than a
    // strip-the-scheme-and-path exercise on this one.
    const { ws } = await openSession({
      streamingUrl: "wss://streaming-tts.sandbox025.assemblyai-labs.com/v1/ws/?trace=1",
      voice: "scottish_vs",
    });
    const url = new URL(ws.url);
    expect(url.host).toBe("streaming-tts.sandbox025.assemblyai-labs.com");
    expect(url.pathname).toBe("/v1/ws/");
    expect(url.searchParams.get("trace")).toBe("1");
    expect(url.searchParams.get("voice")).toBe("scottish_vs");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
  });

  test("the deprecated bare `host` still works, and streamingUrl wins over it", async () => {
    const { ws: bare } = await openSession({
      host: "streaming-tts.sandbox025.assemblyai-labs.com",
    });
    expect(new URL(bare.url).host).toBe("streaming-tts.sandbox025.assemblyai-labs.com");
    expect(new URL(bare.url).pathname).toBe("/v1/ws/");

    const { ws } = await openSession({
      host: "streaming-tts.sandbox000.assemblyai-labs.com",
      streamingUrl: "wss://streaming-tts.sandbox025.assemblyai-labs.com/v1/ws/",
    });
    expect(new URL(ws.url).host).toBe("streaming-tts.sandbox025.assemblyai-labs.com");
  });

  test.each([
    ["a bare host with no scheme", "streaming-tts.sandbox025.assemblyai-labs.com/v1/ws/"],
    ["an http(s) paste", "https://streaming-tts.sandbox025.assemblyai-labs.com/v1/ws/"],
  ])("open() throws tts_connect_failed for streamingUrl that is %s", async (_why, streamingUrl) => {
    // `new WebSocket` throws a bare SyntaxError from inside the adapter's own
    // open path for both, which reads as an adapter bug rather than as a value
    // to fix — so the refusal names the option and the expected shape.
    const opener = openAssemblyAITts({ streamingUrl });
    await expect(
      opener.open({ sampleRate: 16_000, apiKey: "k", signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      code: "tts_connect_failed",
      message: expect.stringContaining("streamingUrl"),
    });
  });

  test("an empty override falls through to production rather than dialing wss:///", async () => {
    const { ws } = await openSession({ streamingUrl: "", host: "" });
    expect(new URL(ws.url).host).toBe("streaming-tts.assemblyai.com");
  });

  test("defaults the voice and omits language unless set", async () => {
    const { ws } = await openSession();
    const params = new URL(ws.url).searchParams;
    expect(params.get("voice")).toBe("jane");
    // Every voice speaks one language; a mismatched pair is worse than no hint.
    expect(params.has("language")).toBe(false);
  });

  test("sends the language as the API's full name, not the ISO 639-1 code", async () => {
    // The service rejects codes in-band: `Bad connection parameters: language:
    // language 'es' not in supported set ['english', ...]` — which arrives
    // AFTER the socket opens, so an unmapped code is a silently mute session.
    const { ws } = await openSession({ voice: "lola", language: "es" });
    expect(new URL(ws.url).searchParams.get("language")).toBe("spanish");
  });

  test.each<[AssemblyAITtsLanguage, string]>([
    ["en", "english"],
    ["fr", "french"],
    ["de", "german"],
    ["it", "italian"],
    ["pt", "portuguese"],
    ["es", "spanish"],
  ])("maps %s to %s", async (code, wire) => {
    const { ws } = await openSession({ language: code });
    expect(new URL(ws.url).searchParams.get("language")).toBe(wire);
  });

  test("open() throws tts_connect_failed for an unsupported language", async () => {
    // Fail at connect rather than let the service refuse in-band: the
    // descriptor reaches the host as unvalidated `Record<string, unknown>`
    // options, so this is the only place a bad value can be caught.
    const opener = openAssemblyAITts({ language: "zh" as "es" });
    await expect(
      opener.open({ sampleRate: 16_000, apiKey: "k", signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      code: "tts_connect_failed",
      message: expect.stringContaining("zh"),
    });
  });

  test("authenticates with the raw API key, not a Bearer token", async () => {
    // A Bearer token upgrades fine and is then refused in-band as an Error
    // frame, so this is the difference between working and a runtime failure.
    const { ws } = await openSession({}, "sk-abc123");
    expect(ws.options?.headers?.Authorization).toBe("sk-abc123");
  });

  test("opens with permessage-deflate disabled", async () => {
    // `ws` defaults this to true on CLIENTS, and a provider that accepts the
    // offer costs a zlib context per socket (+321 KiB RSS, ~4.5x CPU, measured)
    // to compress PCM16, which does not compress. See PROVIDER_WS_OPTIONS.
    const { ws } = await openSession({}, "sk-abc123");
    expect(ws.options?.perMessageDeflate).toBe(false);
  });

  test("open() throws tts_auth_failed when the API key is missing", async () => {
    const opener = openAssemblyAITts({});
    await expect(
      opener.open({ sampleRate: 16_000, apiKey: "", signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "tts_auth_failed" });
  });
});
