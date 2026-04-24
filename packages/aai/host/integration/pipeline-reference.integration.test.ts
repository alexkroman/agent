// Copyright 2025 the AAI authors. MIT license.
/**
 * Integration test for the pluggable-providers pipeline reference stack.
 *
 * Runs only when VITEST_PROFILE=integration is set AND all three API keys
 * plus the input audio fixture are available. Exercises the full STT → LLM → TTS
 * path with real providers (AssemblyAI u3pro-rt + OpenAI gpt-4o-mini +
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
import { openai } from "@ai-sdk/openai";
import { describe, expect, test } from "vitest";
import type { ClientSink } from "../../sdk/protocol.ts";
import { openAssemblyAI } from "../providers/stt/assemblyai.ts";
import { openCartesia } from "../providers/tts/cartesia.ts";
import { createRuntime } from "../runtime.ts";
import { consoleLogger } from "../runtime-config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "fixtures/hello-how-are-you.pcm16");

async function fixtureExists(): Promise<boolean> {
  try {
    const s = await stat(fixturePath);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

const envReady = Boolean(
  process.env.VITEST_PROFILE === "integration" &&
    process.env.ASSEMBLYAI_API_KEY &&
    process.env.OPENAI_API_KEY &&
    process.env.CARTESIA_API_KEY,
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
      config: () => undefined,
      audio: (chunk) => {
        audioOut.push(chunk);
      },
      audioDone: () => undefined,
      speechStarted: () => undefined,
      speechStopped: () => undefined,
      userTranscript: (text) => {
        userTranscripts.push(text);
      },
      agentTranscript: () => undefined,
      toolCall: () => undefined,
      toolCallDone: () => undefined,
      replyDone: () => {
        replyDone = true;
      },
      cancelled: () => undefined,
      reset: () => undefined,
      idleTimeout: () => undefined,
      error: () => undefined,
      customEvent: () => undefined,
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
        ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY!,
        // biome-ignore lint/style/noNonNullAssertion: envReady guard ensures presence
        CARTESIA_API_KEY: process.env.CARTESIA_API_KEY!,
      },
      stt: openAssemblyAI({ model: "u3pro-rt" }),
      llm: openai("gpt-4o-mini"),
      tts: openCartesia({ voice: "694f9389-aac1-45b6-b726-9d9369183238" }),
      logger: consoleLogger,
    });

    const session = runtime.createSession({
      id: "int-1",
      agent: "pipeline-reference",
      client,
    });

    await session.start();
    session.onAudioReady();

    // Stream the PCM fixture in ~100ms chunks (16 kHz PCM16 → 3200 bytes/100ms).
    const chunkBytes = 3200;
    for (let i = 0; i < pcm.length; i += chunkBytes) {
      const chunk = pcm.subarray(i, Math.min(i + chunkBytes, pcm.length));
      session.onAudio(new Uint8Array(chunk));
      await new Promise((r) => setTimeout(r, 100));
    }
    await session.stop();

    expect(userTranscripts.some((t) => t.toLowerCase().includes("how are you"))).toBe(true);
    expect(replyDone).toBe(true);
    expect(audioOut.length).toBeGreaterThan(0);
  }, 60_000);
});
