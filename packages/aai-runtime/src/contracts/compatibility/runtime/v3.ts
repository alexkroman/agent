// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring template: `aai-runtime:runtime` epoch 3.
 *
 * Running a session over a host's OWN audio I/O, the way epoch 3 allowed it:
 * `Runtime.createSession` with a hand-written `ClientSink`, then `start()`,
 * `onAudio()` and `command()` on the `ServerSession` it returns. It must keep
 * compiling for as long as epoch 3 is advertised as supported.
 *
 * ## What moved, and why epoch 3 survives it
 *
 * Epoch 4 adds `Runtime.connect(sink, options)` and the two types it speaks,
 * `SessionConnection` and `SessionConnectOptions`. It is the supported way to
 * do what this file does by hand: `createSession` hands back a bare session and
 * leaves the host to apply the start deadline, buffer input that arrives while
 * the session is starting, pace agent audio to real time, and claim the id so a
 * resume can evict the previous connection. `connect` runs the same lifecycle
 * the WebSocket path runs, which is why it exists.
 *
 * Nothing here was removed or narrowed. `Runtime` GAINED a member, and a host
 * RECEIVES a `Runtime` from `createRuntime` rather than building one, so a
 * member added to it is a gift, not an obligation — that is what makes this a
 * retain. The direction that WOULD break is `createSession` changing its option
 * bag or `ClientSink` demanding a member the literal below does not supply.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 3 has to be dropped with a reason.
 *
 * @module
 */

import { agent } from "@alexkroman1/aai";
import type { ClientSink } from "@alexkroman1/aai/protocol";
import { createRuntime, type Runtime } from "../../../runtime-barrel.ts";

/**
 * The agent this host runs.
 *
 * EDIT THIS. Everything below is wiring; this is the agent.
 */
const desk = agent({
  name: "Kiosk",
  systemPrompt: "You are a lobby kiosk. Keep answers to one sentence.",
  greeting: "Hello, how can I help?",
});

/** The runtime this process runs sessions on. */
export const runtime: Runtime = createRuntime({
  agent: desk,
  env: { ASSEMBLYAI_API_KEY: "not-a-real-key" },
});

/**
 * ── EDIT: where the session's output goes. ──────────────────────────────
 *
 * A kiosk's speaker and screen. The sink is the whole output contract: events
 * (JSON-shaped, typed) and agent audio (PCM16 mono at
 * `runtime.readyConfig.ttsSampleRate`).
 */
export function kioskSink(play: (pcm16: Uint8Array) => void, flush: () => void): ClientSink {
  return {
    open: true,
    event(event) {
      if (event.type === "reply.cancelled" || event.type === "session.reset") flush();
    },
    playAudioChunk: play,
  };
}

/**
 * ── EDIT: one visitor walking up to the kiosk. ──────────────────────────
 *
 * The session starts, is told the speaker is ready (which releases the
 * greeting), and is fed the microphone. The returned function ends it.
 */
export async function visit(
  id: string,
  sink: ClientSink,
  subscribe: (onMic: (pcm16: Uint8Array) => void) => void,
): Promise<() => Promise<void>> {
  const session = runtime.createSession({ id, agent: desk.name, client: sink });
  session.configure(runtime.readyConfig);
  await session.start();
  session.command({ type: "audio_ready" });
  subscribe((pcm16) => session.onAudio(pcm16));
  return () => session.stop();
}
