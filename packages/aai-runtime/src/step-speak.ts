// Copyright 2026 the AAI authors. MIT license.
/**
 * The published half of {@link stepSpeak}: one AssemblyAI streaming-TTS socket
 * per utterance, collected into raw PCM16.
 *
 * `sdk/step-speak.ts` is the surface a step calls and carries the argument for
 * why it exists — read that first. It may not import `ws`, being on the CLI's
 * zero-dependency startup path and riding the browser bundle, so the socket
 * lives here and `createServerForRuntime` publishes it.
 *
 * ## It is NOT the session opener, and the difference is the point
 *
 * `host/providers/tts/assemblyai.ts` speaks the same protocol against the same
 * endpoint, and none of it is reusable here. That opener is a long-lived
 * session: it segments a reply so time-to-first-audio is a sentence rather
 * than a turn, tracks which flush ends a turn, filters an abandoned turn's
 * frames after a barge-in, and reconnects when a `Cancel` goes unanswered.
 * Every one of those exists because somebody is LISTENING while the words are
 * still being chosen.
 *
 * A step has none of that. The text is complete before the socket opens, there
 * is no turn, nothing can barge in, and the caller wants one value. So this is
 * the whole exchange:
 *
 * ```text
 *   open      wss://tts.us.assemblyai.com/v1/ws?voice_id=&sample_rate=
 *   send      {"type":"Generate","text":"…"} × N  (≤2000 chars each; buffers)
 *   send      {"type":"Flush"}                    (concludes the request)
 *   receive   {"type":"Audio","audio":"<base64 PCM16 LE>"} × N
 *   receive   {"type":"FlushDone"}
 *   send      {"type":"Terminate"}
 * ```
 *
 * **`Flush` is what concludes a request** — short text stays buffered until it
 * — so the frames are sent together and a step that forgot it would wait out
 * its deadline having received nothing. The URL and the `Generate` framing are
 * shared with the session opener (`providers/tts/assemblyai-wire.ts`); the frame
 * vocabulary is https://www.assemblyai.com/docs/tts/message-frames.
 *
 * ## One socket per utterance, and it is not a pool
 *
 * A step runs once and returns a value, so there is nothing for a connection
 * to be reused BY: the next `stepSpeak` may be in a different step, a
 * different run, or a different process after a resume. `stepFetch` pools
 * because a fan-out makes N calls from one body; this cannot, and a pool here
 * would be an idle socket per agent holding a provider connection open for
 * work that may never come.
 *
 * ## Every failure is a THROW, and the DevKit decides what to do
 *
 * A refused key, a socket that closes mid-synthesis, an `Error` frame, a
 * deadline — all of them reject, and the step's own retry policy is what
 * decides whether to try again. Nothing here classifies: `sdk/step-errors.ts`
 * is where a caller says a failure is fatal, and a synthesizer that guessed
 * would be guessing for every caller.
 */

import type { SpeechSynthesizer } from "@alexkroman1/aai/host-internal";
import { errorMessage, safeJsonParse } from "@alexkroman1/aai/utils";
import WebSocket from "ws";
import { base64ToUint8 } from "./_base64.ts";
import { PROVIDER_WS_OPTIONS } from "./_ws.ts";
import type { ProviderSocket } from "./providers/_utils.ts";
import { assemblyAITtsUrl, generateFrames } from "./providers/tts/assemblyai-wire.ts";
import { withWalkSignal } from "./workflow/run-context.ts";

/** The frames this exchange reads. See `providers/tts/assemblyai-frames.ts`. */
type TtsFrame = {
  type?: string;
  /** Base64 PCM16 LE payload, on `Audio` frames. */
  audio?: string;
  error?: string;
  error_code?: string | number;
};

/** The socket URL for one utterance — voice and rate are fixed at connect. */
function speechUrl(request: {
  voice: string;
  language?: string | undefined;
  sampleRate: number;
}): string {
  // An unsupported language must throw HERE: the service's own refusal arrives
  // in band after the upgrade, which would fail later with less to go on.
  return assemblyAITtsUrl(request, (msg) => new Error(`stepSpeak: ${msg}`));
}

/** Join the collected frames, sizing the buffer in one pass first. */
function joinPcm(frames: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const frame of frames) total += frame.length;
  const pcm = new Uint8Array(total);
  let at = 0;
  for (const frame of frames) {
    pcm.set(frame, at);
    at += frame.length;
  }
  return pcm;
}

/**
 * Read one server frame: collect its audio, and say whether the exchange is
 * over.
 *
 * Separate from the listener so the socket lifecycle and the FRAME vocabulary
 * are two things — the same split `providers/tts/assemblyai-frames.ts` makes
 * next door, and the one biome's complexity ceiling asks for.
 *
 * `undefined` means "keep listening", which covers a frame that carried audio
 * as much as one this does not understand: `Begin` echoes the configuration and
 * `WordBoundaries` is not read here.
 */
function readFrame(
  raw: WebSocket.Data,
  frames: Uint8Array[],
): { pcm: Uint8Array } | { error: Error } | undefined {
  const frame = safeJsonParse(typeof raw === "string" ? raw : raw.toString()) as
    | TtsFrame
    | undefined;
  if (frame === undefined) return undefined;

  if (frame.type === "Audio") {
    if (typeof frame.audio === "string") {
      const bytes = base64ToUint8(frame.audio);
      if (bytes.length > 0) frames.push(bytes);
    }
    return undefined;
  }
  if (frame.type === "FlushDone") return { pcm: joinPcm(frames) };
  if (frame.type === "Error") {
    // Where a bad key lands, and a bad voice id: both are accepted at the
    // upgrade and refused in band.
    return {
      error: new Error(
        `AssemblyAI TTS (${frame.error_code ?? ""}): ${frame.error?.trim() || "unknown"}`,
      ),
    };
  }
  return undefined;
}

/**
 * What an aborted synthesis rejects with: the signal's OWN `reason`, never a
 * fresh error wrapping it — the same value an aborted `fetch` rejects with.
 *
 * Identity is load-bearing. `attemptLoop` (`workflow/replay/step.ts`) tells a
 * cancelled walk from a failed step by `err === signal.reason`, so a wrapped
 * abort read as the step's own failure: retried, or journaled `failed` over a
 * run somebody stopped. Only a non-`Error` reason (`abort("why")`) is wrapped,
 * since a step must throw an `Error` and a primitive has no identity to keep.
 */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new Error(`stepSpeak: synthesis aborted (${String(reason)})`);
}

/**
 * Synthesize one utterance and resolve its raw PCM16.
 *
 * The published implementation of {@link SpeechSynthesizer}, exported so
 * `createServerForRuntime` can publish it and a spec can drive it directly.
 *
 * @internal
 */
export const speakOverWebSocket: SpeechSynthesizer = (request) => speakOver(request);

/**
 * How {@link speakOver} constructs its socket — the seam a spec hands a fake
 * through instead of replacing the `ws` module.
 *
 * @internal
 */
export type CreateSpeechSocket = (url: string, options: WebSocket.ClientOptions) => ProviderSocket;

/** The production {@link CreateSpeechSocket}: a real `ws` client, which DIALS. */
const dialSpeech: CreateSpeechSocket = (url, options) => new WebSocket(url, options);

/**
 * {@link speakOverWebSocket} with the socket constructor as a parameter.
 *
 * @internal
 */
export const speakOver = (
  request: Parameters<SpeechSynthesizer>[0],
  createSocket: CreateSpeechSocket = dialSpeech,
): Promise<Uint8Array> =>
  new Promise<Uint8Array>((resolve, reject) => {
    // Built before the socket so an unsupported language rejects without
    // dialling anything.
    let url: string;
    try {
      url = speechUrl(request);
    } catch (err: unknown) {
      reject(err instanceof Error ? err : new Error(errorMessage(err)));
      return;
    }

    // The step's own signal (its deadline, folded in by `sdk/step-speak.ts`)
    // plus the WALK's, read from the run context exactly as `stepFetch` does —
    // so cancelling a run stops a synthesis it has no further use for instead
    // of leaving a billed socket open until the deadline.
    const signal = withWalkSignal(request.signal);
    // Before the socket, not after: `new WebSocket` DIALS, so a check placed
    // below it opened (and billed the handshake of) a connection only to
    // terminate it a line later.
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const frames: Uint8Array[] = [];
    // The raw key, as the docs show — see the module doc.
    const ws = createSocket(url, {
      headers: { Authorization: request.apiKey },
      ...PROVIDER_WS_OPTIONS,
    });
    let settled = false;

    /**
     * Settle once and release the socket.
     *
     * A single exit for all five paths (done, error frame, socket error,
     * close, abort), because each of them can land after another has already
     * won: an `Error` frame is routinely followed by a close, and an abort
     * mid-synthesis produces both. A second settle would be silent; a socket
     * left open would not.
     */
    const finish = (outcome: { pcm: Uint8Array } | { error: Error }): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      ws.removeAllListeners();
      // A polite `Terminate` only where the socket can still carry one; a
      // failed exchange is not worth waiting on a frame for.
      if (ws.readyState === WebSocket.OPEN) {
        if ("pcm" in outcome) ws.send(JSON.stringify({ type: "Terminate" }));
        ws.close(1000);
      } else {
        ws.terminate();
      }
      if ("pcm" in outcome) resolve(outcome.pcm);
      else reject(outcome.error);
    };

    const onAbort = (): void => finish({ error: abortError(signal) });
    signal.addEventListener("abort", onAbort, { once: true });

    ws.on("open", () => {
      // Together, and in this order: the `Flush` concludes the request. The text
      // goes as several `Generate` frames past the per-frame cap.
      for (const frame of generateFrames(request.text)) ws.send(JSON.stringify(frame));
      ws.send(JSON.stringify({ type: "Flush" }));
    });

    ws.on("message", (raw: WebSocket.Data) => {
      const outcome = readFrame(raw, frames);
      if (outcome !== undefined) finish(outcome);
    });

    ws.on("error", (err: Error) =>
      finish({ error: new Error(`AssemblyAI TTS: ${errorMessage(err)}`) }),
    );

    // Any close reaching here is one this did not initiate — `finish` detaches
    // every listener before closing. Mid-synthesis that means the audio is
    // incomplete, and returning what arrived would be a truncated file with
    // nothing anywhere reporting one.
    ws.on("close", (code: number) =>
      finish({ error: new Error(`AssemblyAI TTS: socket closed ${code} before the audio ended`) }),
    );
  });
