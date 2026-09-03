// Copyright 2026 the AAI authors. MIT license.
/**
 * How pipeline mode reports a session error — and above all, when it may say the
 * session is OVER.
 *
 * An `error.reported` with no `fatal` key means the session is OVER, and a fatal
 * frame is not a
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
 * The `EmitError` signature survives the collapse of the callback surface, and
 * deliberately: it is threaded through the transport's own internals at dozens of
 * call sites, where `emitError("llm", msg, { fatal: false })` is the intent and an
 * event literal would be noise. This function is the one place the two meet.
 *
 * `fatal` is REQUIRED on the wire, so a caller that says nothing means the
 * terminal case and this is where that becomes explicit — the default is `true`,
 * stated once here rather than inferred from an absent key by every reader.
 *
 * **All THREE transports use it**, despite the file's name: the S2S and OpenAI
 * Realtime transports had each written the two event literals out by hand, which
 * is four independent spellings of one decision — and the decision is "may this
 * frame end the call". The module doc above is pipeline-specific because pipeline mode is
 * where the reporters are numerous; the rule it states is not.
 *
 * @internal
 */
export function createEmitError(callbacks: TransportCallbacks): EmitError {
  return (code, message, errOpts) => {
    callbacks.report({
      type: "error.reported",
      code,
      message,
      fatal: errOpts?.fatal ?? true,
    });
  };
}
