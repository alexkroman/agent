// Copyright 2025 the AAI authors. MIT license.
/**
 * Integration test for the pluggable-providers pipeline reference stack.
 *
 * Exercises the full STT → LLM → TTS path with real providers (AssemblyAI
 * universal-3-5-pro + OpenAI gpt-4o-mini + Cartesia) so latency and
 * wire-format issues are caught before release.
 *
 * ## This suite had never executed, in either arm
 *
 * It gated on all three API keys and then built `createRuntime({ env })`
 * carrying only two of them while declaring `llm: openaiLlm(...)`. `resolveLlm`
 * reads the AGENT env and nothing else (see `resolveApiKey`'s doc: there is
 * deliberately no `process.env` fallback), so the credentialed arm threw
 * `OpenAI LLM: missing API key` at `session.start()` — and the shell exports
 * the README names are not a fallback path, `withHostCredentialFallback`
 * being opt-in and unused here. The other arm was dead too: the fixture is
 * not checked in, so the run threw on the missing file first. Both are fixed
 * below: the agent env is DERIVED from the same `*_API_KEY_ENV` constants the
 * resolvers read, and the fixture is part of the gate rather than a throw
 * inside the one arm that was unreachable.
 *
 * ## A skip announces itself
 *
 * Same rule the Postgres-gated scenario suites follow: a silent skip is the
 * worst outcome available, because it is indistinguishable from a pass. A run
 * that cannot satisfy the requirements prints exactly which ones are missing,
 * and `AAI_REQUIRE_REFERENCE_STACK=1` turns the skip into a hard failure for
 * a pipeline that means to enforce it.
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

import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASSEMBLYAI_STT_API_KEY_ENV,
  CARTESIA_API_KEY_ENV,
  OPENAI_API_KEY_ENV,
} from "@alexkroman1/aai/host-internal";
import { openaiLlm } from "@alexkroman1/aai/llm";
import type { ClientSink } from "@alexkroman1/aai/protocol";
import { assemblyAIStt } from "@alexkroman1/aai/stt";
import { cartesiaTts } from "@alexkroman1/aai/tts";
import { describe, expect, test } from "vitest";
import { sleep } from "../_test-utils.ts";
import { createRuntime } from "../runtime.ts";
import { consoleLogger } from "../runtime-config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "fixtures/hello-how-are-you.pcm16");

/** Env var that turns a skip into a failure — see the module doc. */
const REQUIRE_ENV = "AAI_REQUIRE_REFERENCE_STACK";

/**
 * The keys this stack authenticates with, named by the SAME constants the
 * resolvers read rather than by string literals here — which is the whole
 * defect this file carried: the gate listed three and the agent env carried
 * two, and nothing could see the disagreement.
 */
const REQUIRED_KEYS = [
  ASSEMBLYAI_STT_API_KEY_ENV,
  OPENAI_API_KEY_ENV,
  CARTESIA_API_KEY_ENV,
] as const;

function agentEnvFromShell(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of REQUIRED_KEYS) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

function fixturePresent(): boolean {
  const s = statSync(fixturePath, { throwIfNoEntry: false });
  if (s === undefined || !s.isFile()) return false;
  return s.size > 0;
}

const agentEnv = agentEnvFromShell();
const missing: string[] = REQUIRED_KEYS.filter((name) => !(name in agentEnv));
if (!fixturePresent()) missing.push(`audio fixture ${fixturePath}`);

const requireStack = process.env[REQUIRE_ENV] === "1";
if (missing.length > 0 && !requireStack) {
  console.warn(
    `[pipeline-reference] SKIPPED — missing: ${missing.join(", ")}. ` +
      `See host/integration/fixtures/README.md. Set ${REQUIRE_ENV}=1 to make this a failure.`,
  );
}

describe.skipIf(missing.length > 0 && !requireStack)(
  "pipeline integration — reference stack",
  () => {
    test("audio in → transcript, LLM reply, TTS audio out", async () => {
      // A no-op when the gate is satisfied. It can only FAIL under
      // `AAI_REQUIRE_REFERENCE_STACK=1`, which is what the describe above
      // deliberately does not skip: that is the whole "fail loudly instead of
      // silently" half of the gate.
      expect(missing, `${REQUIRE_ENV}=1, but these are missing`).toEqual([]);
      const pcm = await readFile(fixturePath);
      const userTranscripts: string[] = [];
      const audioOut: Uint8Array[] = [];
      let replyDone = false;

      const client: ClientSink = {
        open: true,
        event: (e) => {
          if (e.type === "user-transcript.committed") userTranscripts.push(e.text);
          else if (e.type === "reply.completed") replyDone = true;
        },
        playAudioChunk: (chunk) => {
          audioOut.push(chunk);
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
        // All three keys, because all three stages resolve from HERE and
        // nowhere else. Two of them used to be enough to pass the gate and
        // never enough to run the test.
        env: agentEnv,
        // Descriptors, not pre-resolved openers — so this exercises the same
        // resolution path (and API-key routing) a deployed agent takes.
        stt: assemblyAIStt({ model: "universal-3-5-pro" }),
        llm: openaiLlm({ model: "gpt-4o-mini" }),
        tts: cartesiaTts({ voice: "694f9389-aac1-45b6-b726-9d9369183238" }),
        logger: consoleLogger,
      });

      const session = runtime.createSession({
        id: "int-1",
        agent: "pipeline-reference",
        client,
      });

      await session.start();
      session.command({ type: "audio_ready" });

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
  },
);
