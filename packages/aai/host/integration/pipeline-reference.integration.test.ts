// Copyright 2025 the AAI authors. MIT license.
/**
 * Integration test for the pluggable-providers pipeline reference stack.
 *
 * Runs only when VITEST_PROFILE=integration is set AND all three API keys
 * plus the input audio fixture are available. Exercises the full STT → LLM → TTS
 * path with real providers (AssemblyAI universal-3-5-pro + OpenAI gpt-4o-mini +
 * Cartesia) so latency and wire-format issues are caught before release.
 *
 * To run locally:
 *
 *   export ASSEMBLYAI_API_KEY=...
 *   export OPENAI_API_KEY=...
 *   export CARTESIA_API_KEY=...
 *   VITEST_PROFILE=integration \
 *     VITEST_INCLUDE=host/integration/**\/*.integration.test.ts \
 *     pnpm --filter @alexkroman1/aai exec vitest run -c ../../vitest.slow.config.ts
 *
 * See fixtures/README.md for how to generate the required audio input.
 */

import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { ClientSink } from "../../sdk/protocol.ts";
import { openai } from "../../sdk/providers/llm/openai.ts";
import { assemblyAIStt } from "../../sdk/providers/stt/assemblyai.ts";
import { cartesia } from "../../sdk/providers/tts/cartesia.ts";
import { sleep } from "../_test-utils.ts";
import { createRuntime } from "../runtime.ts";
import { consoleLogger } from "../runtime-config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "fixtures/hello-how-are-you.pcm16");

async function fixtureExists(): Promise<boolean> {
  const s = await stat(fixturePath).catch(() => null);
  return (s?.isFile() && s.size > 0) ?? false;
}

const { ASSEMBLYAI_API_KEY, OPENAI_API_KEY, CARTESIA_API_KEY, VITEST_PROFILE } = process.env;
const envReady = Boolean(
  VITEST_PROFILE === "integration" && ASSEMBLYAI_API_KEY && OPENAI_API_KEY && CARTESIA_API_KEY,
);

describe.skipIf(!envReady)("pipeline integration — reference stack", () => {
  test("audio in → transcript, LLM reply, TTS audio out", async () => {
    if (!(await fixtureExists())) {
      throw new Error(
        `Fixture not found at ${fixturePath}. ` +
          "See fixtures/README.md for instructions on generating it.",
      );
    }
    const pcm = await readFile(fixturePath);
    const userTranscripts: string[] = [];
    const audioOut: Uint8Array[] = [];
    let replyDone = false;

    const client: ClientSink = {
      open: true,
      event: (e) => {
        if (e.type === "user_transcript") userTranscripts.push(e.text);
        else if (e.type === "reply_done") replyDone = true;
      },
      playAudioChunk: (chunk) => {
        audioOut.push(chunk);
      },
      playAudioDone: () => {
        /* no-op */
      },
    };

    const runtime = createRuntime({
      agent: {
        name: "int",
        systemPrompt: "You reply in one short sentence.",
        greeting: "",
        maxSteps: 1,
        tools: {},
      },
      env: {
        // biome-ignore lint/style/noNonNullAssertion: envReady guard ensures presence
        ASSEMBLYAI_API_KEY: ASSEMBLYAI_API_KEY!,
        // biome-ignore lint/style/noNonNullAssertion: envReady guard ensures presence
        CARTESIA_API_KEY: CARTESIA_API_KEY!,
      },
      // Descriptors, not pre-resolved openers — so this exercises the same
      // resolution path (and API-key routing) a deployed agent takes.
      stt: assemblyAIStt({ model: "universal-3-5-pro" }),
      llm: openai({ model: "gpt-4o-mini" }),
      tts: cartesia({ voice: "694f9389-aac1-45b6-b726-9d9369183238" }),
      logger: consoleLogger,
    });

    const session = runtime.createSession({
      id: "int-1",
      agent: "pipeline-reference",
      client,
    });

    await session.start();
    session.onAudioReady();

    // 16 kHz PCM16 → 3200 bytes per 100ms.
    const chunkBytes = 3200;
    for (let i = 0; i < pcm.length; i += chunkBytes) {
      session.onAudio(new Uint8Array(pcm.subarray(i, i + chunkBytes)));
      await sleep(100);
    }
    await session.stop();

    expect(userTranscripts.some((t) => t.toLowerCase().includes("how are you"))).toBe(true);
    expect(replyDone).toBe(true);
    expect(audioOut.length).toBeGreaterThan(0);
  }, 60_000);
});
