// Copyright 2026 the AAI authors. MIT license.
// Session-open helper shared by the AssemblyAI TTS adapter specs. Separate
// from _fake-ws-test-utils.ts because this module imports the
// adapter (which imports "ws"), and the mock factory must not.

import type { AssemblyAITtsOptions } from "@alexkroman1/aai/tts";
import { flush } from "../../_test-utils.ts";
import { FakeWebSocket } from "./_fake-ws-test-utils.ts";
import { type AssemblyAITtsSession, openAssemblyAITts } from "./assemblyai.ts";

export async function openSession(
  opts: AssemblyAITtsOptions = {},
  apiKey = "test-key",
): Promise<{
  session: AssemblyAITtsSession;
  ws: FakeWebSocket;
  controller: AbortController;
}> {
  const opener = openAssemblyAITts(opts);
  const controller = new AbortController();
  const openPromise = opener.open({
    sampleRate: 16_000,
    apiKey,
    signal: controller.signal,
  }) as Promise<AssemblyAITtsSession>;
  await flush(); // let the queued "open" microtask run
  const session = await openPromise;
  const ws = FakeWebSocket.instances.at(-1);
  if (!ws) throw new Error("no WebSocket was constructed");
  return { session, ws, controller };
}
