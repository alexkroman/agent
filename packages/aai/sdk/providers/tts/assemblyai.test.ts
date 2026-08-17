// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import {
  ASSEMBLYAI_TTS_HOST,
  ASSEMBLYAI_TTS_PATH,
  ASSEMBLYAI_TTS_URL,
  resolveAssemblyAITtsSettings,
  resolveAssemblyAITtsUrl,
} from "./assemblyai.ts";

const SANDBOX = "wss://streaming-tts.sandbox025.assemblyai-labs.com/v1/ws/";

describe("resolveAssemblyAITtsUrl", () => {
  test("defaults to the production endpoint, path included", () => {
    expect(resolveAssemblyAITtsUrl({})).toBe(ASSEMBLYAI_TTS_URL);
    expect(ASSEMBLYAI_TTS_URL).toBe(`wss://${ASSEMBLYAI_TTS_HOST}${ASSEMBLYAI_TTS_PATH}`);
  });

  test("takes streamingUrl verbatim", () => {
    expect(resolveAssemblyAITtsUrl({ streamingUrl: SANDBOX })).toBe(SANDBOX);
  });

  test("supplies the versioned path for the deprecated bare host", () => {
    expect(resolveAssemblyAITtsUrl({ host: "streaming-tts.sandbox025.assemblyai-labs.com" })).toBe(
      SANDBOX,
    );
  });

  test("streamingUrl wins over host", () => {
    expect(
      resolveAssemblyAITtsUrl({
        host: "streaming-tts.sandbox000.assemblyai-labs.com",
        streamingUrl: SANDBOX,
      }),
    ).toBe(SANDBOX);
  });

  test("an empty override is unset, not `wss:///v1/ws/`", () => {
    expect(resolveAssemblyAITtsUrl({ streamingUrl: "", host: "" })).toBe(ASSEMBLYAI_TTS_URL);
  });
});

describe("resolveAssemblyAITtsSettings", () => {
  test("omits streamingUrl on production so the common log line stays short", () => {
    expect(resolveAssemblyAITtsSettings({})).toEqual({ voice: "jane" });
  });

  test("reports the resolved endpoint whichever option set it", () => {
    // The `host` shorthand used to reach the wire with nothing anywhere naming
    // the cluster a session was dialing — which is exactly what gets blamed when
    // a sandbox key is rejected by production.
    expect(resolveAssemblyAITtsSettings({ streamingUrl: SANDBOX })).toMatchObject({
      streamingUrl: SANDBOX,
    });
    expect(
      resolveAssemblyAITtsSettings({ host: "streaming-tts.sandbox025.assemblyai-labs.com" }),
    ).toMatchObject({ streamingUrl: SANDBOX });
  });
});
