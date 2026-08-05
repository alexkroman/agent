// Copyright 2026 the AAI authors. MIT license.
/**
 * How pipeline mode reports a session error — and above all, when it may say the
 * session is OVER.
 *
 * `TransportCallbacks.onError` defaults to fatal, and a fatal frame is not a
 * banner: aai-ui's `handleErrorEvent` calls `cleanupAudio()`, bumps the
 * connection generation, and sets `running: false`. The microphone is RELEASED
 * and the call ends. So only the paths that really terminate the session may omit
 * `fatal`, and in pipeline mode there are exactly two — `onProviderError` and the
 * provider-open rejection, both of which call `terminate()` (a session whose STT
 * never opened cannot hear anyone).
 *
 * Every turn-level reporter passes `{ fatal: false }`: an `error` part in the LLM
 * stream, a thrown `streamText`, and a TTS flush timeout. Reported as fatal, the
 * first two were especially perverse — the transport's next act is to speak
 * `errorPhrase` ("Sorry, I had a problem just then. Could you say that again?")
 * and invite another turn, so the caller was asked to repeat themselves into a
 * microphone the client had just switched off, while the TTS case ended a live
 * call over one clipped sentence.
 *
 * The pipeline fuzz's fatality oracle covers both LLM reporters — its script
 * emits `error` parts and its instrumented `doStream` sometimes refuses outright,
 * which are separate code paths. The TTS flush timeout needs a real deadline to
 * elapse, so that one is pinned by a deterministic spec instead
 * (`pipeline-stream.test.ts`, "reports a drain timeout…").
 */

import type { EmitError, TransportCallbacks } from "./types.ts";

/**
 * Bind a transport's error reporter to its callbacks.
 *
 * `errOpts` is forwarded only when there is one, so a terminal report stays a
 * two-argument `onError(code, message)` rather than one carrying an explicit
 * `undefined` — identical to the client either way, and it keeps each call site's
 * intent legible in the specs that assert on it.
 *
 * @internal
 */
export function createEmitError(callbacks: TransportCallbacks): EmitError {
  return (code, message, errOpts) => {
    if (errOpts === undefined) callbacks.onError(code, message);
    else callbacks.onError(code, message, errOpts);
  };
}
