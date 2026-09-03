// Copyright 2026 the AAI authors. MIT license.
/**
 * Server frames for the AssemblyAI streaming TTS adapter: their shape, and the
 * one handler that routes them.
 *
 * Split out for the same reason `assemblyai-segment.ts`, `assemblyai-turn.ts`
 * and `assemblyai-cancel.ts` are — the adapter owns socket and turn lifecycle,
 * this owns one rule.
 *
 * **The client->server vocabulary is exactly `Generate`, `Flush`, `Terminate`,
 * `KeepAlive`, `Cancel`** — not inferred, but read back from the service,
 * which answers an unknown `type` with `expected one of ...`. There is no
 * public documentation for this endpoint at all (AssemblyAI's docs state it
 * does not offer standalone TTS), so that is the only way to know, and it is
 * worth knowing: `Cancel` went unused here for a year because this doc assumed
 * it away, and `KeepAlive` still is. **There is also no continuous/streaming
 * mode** — see `assemblyai-segment.ts`, which owns that consequence. The
 * `Begin` frame likewise echoes a complete `configuration` (`voice`,
 * `language`, `sample_rate`, `encoding` — `pcm_mulaw` is accepted —
 * `inactivity_timeout`, an integer of at least 5 seconds, and
 * `word_boundaries`), and that echo reflects ONLY params the server
 * RECOGNIZES, which makes it how to test whether a new one is real.
 */

import type { TtsEvents } from "@alexkroman1/aai/host-internal";
import { safeJsonParse } from "@alexkroman1/aai/utils";
import type WebSocket from "ws";
import { base64ToUint8 } from "../../_base64.ts";
import { bytesToPcm16 } from "../../_pcm.ts";
import type { SessionShell } from "../_utils.ts";
import type { CancelBarrier } from "./assemblyai-cancel.ts";
import type { SynthesisAck } from "./assemblyai-turn.ts";

export interface AssemblyAITtsMessage {
  type:
    | "Begin"
    | "Audio"
    | "FlushDone"
    | "Warning"
    | "Error"
    | "WordBoundaries"
    | "Cancelled"
    | string;
  /** Base64 PCM16 LE payload on `Audio` frames. */
  audio?: string;
  /** Word timings on `WordBoundaries` frames — shape read defensively. */
  words?: unknown;
  /** Set on the last `Audio` frame of a synthesis by some server versions. */
  is_final?: boolean;
  error?: string;
  error_code?: string | number;
  warning?: string;
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
  onSynthesisComplete: (ack: SynthesisAck) => void,
  onWords: (msg: AssemblyAITtsMessage) => void,
  cancels: CancelBarrier,
): void {
  const msg = safeJsonParse(typeof raw === "string" ? raw : raw.toString()) as
    | AssemblyAITtsMessage
    | undefined;
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
      // Older servers flag the final frame; the live one uses FlushDone.
      if (msg.is_final) onSynthesisComplete("is_final");
      return;
    }
    case "FlushDone":
      onSynthesisComplete("flush_done");
      return;
    case "WordBoundaries":
      // Deliberately NOT an acknowledgement — see the module doc.
      onWords(msg);
      return;
    case "Error":
      shell.streamError(`AssemblyAI TTS ${formatErrorFrame(msg)}`);
      return;
    default:
      // Begin is consumed by the handshake below; Warning is informational.
      return;
  }
}
