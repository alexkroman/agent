// Copyright 2026 the AAI authors. MIT license.
/**
 * Server frames for the AssemblyAI streaming TTS adapter: their shape, and the
 * one handler that routes them.
 *
 * Split out for the same reason `assemblyai-segment.ts`, `assemblyai-turn.ts`
 * and `assemblyai-lifecycle.ts` are — the adapter owns socket and turn lifecycle,
 * this owns one rule.
 *
 * **The vocabulary is https://www.assemblyai.com/docs/tts/message-frames.**
 * Client: `Generate`, `Flush`, `Cancel`, `KeepAlive`, `Terminate`. Server:
 * `Begin`, `Audio`, `FlushDone`, `WordBoundaries`, `Cancelled`, `Termination`,
 * `Error` — and nothing else: there is no warning frame, and no `is_final` on
 * `Audio` (each `Flush` is answered by one `FlushDone`). **There is also no
 * continuous/streaming mode** — see `assemblyai-segment.ts`, which owns that
 * consequence. `Begin.configuration.unknown_params` lists any query param the
 * server did not recognize, which is how to test whether a new one is real.
 */

import { isRecord, safeJsonParse } from "@alexkroman1/aai/utils";
import type WebSocket from "ws";
import { base64ToUint8 } from "../../_base64.ts";
import { bytesToPcm16 } from "../../_pcm.ts";
import type { SessionShell } from "../_utils.ts";
import type { TtsEvents } from "../openers.ts";

/**
 * The cancel window as the frame handler reads it: the `cancelling` phase of
 * `assemblyai-lifecycle.ts`, and the acknowledgement that ends it.
 */
export interface CancelWindow {
  /** Is a cancelled turn's audio still arriving? */
  abandoned(): boolean;
  /** The service acknowledged one `Cancel`. */
  onCancelled(): void;
}

export interface AssemblyAITtsMessage {
  type: "Begin" | "Audio" | "FlushDone" | "Error" | "WordBoundaries" | "Cancelled" | string;
  /** Base64 PCM16 LE payload on `Audio` frames. */
  audio?: string;
  /** Word timings on `WordBoundaries` frames — shape read defensively. */
  words?: unknown;
  error?: string;
  error_code?: string | number;
}

/**
 * `(code): reason`, with a fallback so a detail-less frame still reads.
 *
 * Named for the FRAME rather than `errorDetail`, which is the repo-wide helper
 * in `sdk/utils.ts` (a `cause`/`detail` reader over an unknown throwable) and
 * is in scope everywhere — one name meaning two things in one file is how the
 * wrong one gets imported.
 */
function formatErrorFrame(msg: AssemblyAITtsMessage): string {
  const reason = msg.error?.trim() ? msg.error : "unknown";
  return `(${msg.error_code ?? ""}): ${reason}`;
}

const AUDIO_KEY = Buffer.from('"audio":"', "latin1");
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const COMMA = 0x2c;

/**
 * Parse one server frame, lifting an `Audio` frame's payload out WITHOUT
 * running it through `JSON.parse`.
 *
 * The base64 audio is nearly every byte of the frame, and the generic path
 * decodes the whole frame to UTF-8 and then has the JSON parser scan and copy
 * that payload a second time — `safeJsonParse` was the hottest function of our
 * own in a 900-session profile, on the per-audio-frame path (2.1 µs vs 0.8 µs
 * per 100 ms frame in isolation). So the payload is sliced out as latin1 (base64
 * is ASCII, so that is a copy, not a decode) and only the small remainder is
 * parsed, with `""` standing in for the payload.
 *
 * The lift is taken only where it provably reads the frame as `JSON.parse`
 * would, and anything else falls back to the full parse:
 * - the `"audio":"` match is preceded by `{` or `,`, so its quote is
 *   structural — inside a JSON string every `"` is preceded by `\`;
 * - the value holds no `\` (base64 never does, so an escape means this is not
 *   a plain payload) and the key occurs once;
 * - the remainder parses, and its TOP-LEVEL `audio` is the stand-in — a nested
 *   `audio` key leaves the top-level one absent.
 *
 * @internal Exported for its spec.
 */
export function parseServerFrame(raw: WebSocket.Data): AssemblyAITtsMessage | undefined {
  if (Buffer.isBuffer(raw)) {
    const lifted = liftAudioPayload(raw);
    if (lifted !== undefined) return lifted;
  }
  return safeJsonParse(typeof raw === "string" ? raw : raw.toString()) as
    | AssemblyAITtsMessage
    | undefined;
}

function liftAudioPayload(raw: Buffer): AssemblyAITtsMessage | undefined {
  const key = raw.indexOf(AUDIO_KEY);
  if (key < 1) return undefined;
  const before = raw[key - 1];
  if (before !== OPEN_BRACE && before !== COMMA) return undefined;
  const start = key + AUDIO_KEY.length;
  const end = raw.indexOf(QUOTE, start);
  if (end === -1) return undefined;
  const backslash = raw.indexOf(BACKSLASH, start);
  if (backslash !== -1 && backslash < end) return undefined;
  if (raw.indexOf(AUDIO_KEY, end) !== -1) return undefined;
  // `start - 1` keeps the value's opening quote out of the head; `""` replaces
  // the whole quoted value.
  const rest: unknown = safeJsonParse(
    `${raw.toString("utf8", 0, start - 1)}""${raw.toString("utf8", end + 1)}`,
  );
  if (!isRecord(rest) || rest.audio !== "") return undefined;
  return { ...rest, audio: raw.toString("latin1", start, end) } as AssemblyAITtsMessage;
}

/**
 * Handle one server frame. Extracted to keep `open()` under the cognitive
 * complexity limit; turn state is threaded through the callbacks.
 *
 * Emits through `shell`, never the raw emitter: this runs inside a socket
 * 'message' handler, where a throw from a downstream listener escapes into
 * Node's EventEmitter as an uncaughtException — taking down a multi-tenant host
 * rather than one session.
 */
export function handleMessage(
  raw: WebSocket.Data,
  shell: SessionShell<TtsEvents>,
  onSynthesisComplete: () => void,
  onWords: (msg: AssemblyAITtsMessage) => void,
  cancels: CancelWindow,
): void {
  const msg = parseServerFrame(raw);
  if (msg === undefined) return;

  // `Cancelled` is the line between the abandoned turn and the next one — see
  // the module doc. Everything the socket sent before it belongs to the turn
  // the caller barged in on, so none of it may reach the session; `Error`
  // describes the SOCKET rather than that turn and is always surfaced.
  if (msg.type === "Cancelled") {
    cancels.onCancelled();
    return;
  }
  if (cancels.abandoned() && msg.type !== "Error") return;

  switch (msg.type) {
    case "Audio": {
      if (typeof msg.audio === "string") {
        const pcm = bytesToPcm16(base64ToUint8(msg.audio));
        if (pcm.length > 0) shell.emit("audio", pcm);
      }
      return;
    }
    case "FlushDone":
      onSynthesisComplete();
      return;
    case "WordBoundaries":
      // Deliberately NOT an acknowledgement — see the module doc.
      onWords(msg);
      return;
    case "Error":
      shell.streamError(`AssemblyAI TTS ${formatErrorFrame(msg)}`);
      return;
    default:
      // Begin and Termination carry nothing this adapter acts on.
      return;
  }
}
