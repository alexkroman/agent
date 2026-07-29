// Copyright 2026 the AAI authors. MIT license.
/**
 * AssemblyAI streaming TTS opener (host-only).
 *
 * One long-lived WebSocket per session against
 * `wss://streaming-tts.assemblyai.com/v1/ws/`. Voice, language, and sample
 * rate are fixed at connect time as query params.
 *
 * **Auth.** The streaming sockets (STT and TTS) authenticate with the **raw**
 * API key in `Authorization` — *not* `Bearer <key>`, which is what the Voice
 * Agent socket wants. The raw form is verified working against production; the
 * AssemblyAI CLI additionally reports that a Bearer token upgrades fine and is
 * then refused in-band as an `Error` frame, which would make the mistake look
 * like a runtime failure rather than a handshake rejection.
 *
 * A rejected key arrives the same way — the socket opens, then the server
 * sends `{"type":"Error","error_code":1008,"error":"Unauthorized: Invalid API
 * key"}` — so bad credentials surface as `tts_stream_error`, not
 * `tts_auth_failed` (which only covers a key missing from the agent's env).
 *
 * **Protocol.** The server may open with a `Begin` frame, but this adapter
 * does not wait for one: the rate is already fixed by the `sample_rate` query
 * param, and against production no frame arrives until the client speaks
 * first. (The AssemblyAI CLI blocks on `Begin` before sending anything, which
 * is one reason it treats streaming TTS as sandbox-only.) Client sends
 * `{type:"Generate",text}` per LLM delta and `{type:"Flush"}` to force
 * synthesis of anything buffered; the server replies with `{type:"Audio",
 * audio:<base64 PCM16 LE>}` frames and ends the turn with `FlushDone` (or an
 * `Audio` frame flagged `is_final`). `Warning` frames are informational;
 * `Error` frames carry `error_code` + `error`. `Terminate` closes cleanly.
 */

import { createNanoEvents, type Emitter } from "nanoevents";
import WebSocket from "ws";
import {
  ASSEMBLYAI_TTS_API_KEY_ENV,
  ASSEMBLYAI_TTS_DEFAULT_VOICE,
  ASSEMBLYAI_TTS_HOST,
  type AssemblyAITtsOptions,
} from "../../../sdk/providers/tts/assemblyai.ts";
import {
  makeTtsError,
  type TtsEvents,
  type TtsOpener,
  type TtsOpenOptions,
  type TtsSession,
} from "../../../sdk/providers.ts";
import { errorMessage, safeJsonParse } from "../../../sdk/utils.ts";
import { base64ToUint8 } from "../../_base64.ts";
import { bytesToPcm16 } from "../../_pcm.ts";
import {
  assertPcm16Rate,
  closeOnAbort,
  connectOrThrow,
  createSessionShell,
  requireApiKey,
  waitForOpen,
} from "../_utils.ts";

export interface AssemblyAITtsSession extends TtsSession {
  /** @internal Test-only: exposes the underlying raw WebSocket. */
  readonly _ws: WebSocket;
}

interface AssemblyAITtsMessage {
  type: "Begin" | "Audio" | "FlushDone" | "Warning" | "Error" | string;
  /** Base64 PCM16 LE payload on `Audio` frames. */
  audio?: string;
  /** Set on the last `Audio` frame of a synthesis by some server versions. */
  is_final?: boolean;
  error?: string;
  error_code?: string | number;
  warning?: string;
}

/** `(code): reason`, with a fallback so a detail-less frame still reads. */
function errorDetail(msg: AssemblyAITtsMessage): string {
  const reason = msg.error?.trim() ? msg.error : "unknown";
  return `(${msg.error_code ?? ""}): ${reason}`;
}

function buildUrl(opts: AssemblyAITtsOptions, sampleRate: number): string {
  const params = new URLSearchParams({
    voice: opts.voice ?? ASSEMBLYAI_TTS_DEFAULT_VOICE,
    sample_rate: String(sampleRate),
  });
  // Omitted unless set: every voice speaks one language, so the server infers
  // it, and a mismatched pair is worse than no hint.
  if (opts.language) params.set("language", opts.language);
  return `wss://${ASSEMBLYAI_TTS_HOST}/v1/ws/?${params.toString()}`;
}

/**
 * Handle one server frame. Extracted to keep `open()` under the cognitive
 * complexity limit; turn state is threaded through the callbacks.
 */
function handleMessage(
  raw: WebSocket.Data,
  emitter: Emitter<TtsEvents>,
  emitDoneOnce: () => void,
  streamError: (message: string) => void,
): void {
  const msg = safeJsonParse(typeof raw === "string" ? raw : raw.toString()) as
    | AssemblyAITtsMessage
    | undefined;
  if (msg === undefined) return;

  switch (msg.type) {
    case "Audio": {
      if (typeof msg.audio === "string") {
        const pcm = bytesToPcm16(base64ToUint8(msg.audio));
        if (pcm.length > 0) emitter.emit("audio", pcm);
      }
      // Older servers flag the final frame; the live one uses FlushDone.
      if (msg.is_final) emitDoneOnce();
      return;
    }
    case "FlushDone":
      emitDoneOnce();
      return;
    case "Error":
      streamError(`AssemblyAI TTS ${errorDetail(msg)}`);
      return;
    default:
      // Begin is consumed by the handshake below; Warning is informational.
      return;
  }
}

export function openAssemblyAITts(opts: AssemblyAITtsOptions): TtsOpener {
  return {
    name: "assemblyai",
    async open(openOpts: TtsOpenOptions): Promise<TtsSession> {
      const apiKey = requireApiKey(
        openOpts.apiKey,
        ASSEMBLYAI_TTS_API_KEY_ENV,
        "AssemblyAI TTS",
        (msg) => makeTtsError("tts_auth_failed", msg),
      );
      const connectError = (msg: string) => makeTtsError("tts_connect_failed", msg);
      const sampleRate = assertPcm16Rate(openOpts.sampleRate, "AssemblyAI TTS", connectError);

      let ws: WebSocket;
      try {
        // Raw key, not `Bearer` — see the module doc.
        ws = new WebSocket(buildUrl(opts, sampleRate), { headers: { Authorization: apiKey } });
      } catch (cause) {
        throw connectError(`AssemblyAI TTS: failed to create WebSocket: ${errorMessage(cause)}`);
      }

      // Placeholder 'error' listener bound before connecting (see the
      // cartesia.ts pattern): waitForOpen's own listener is removed once it
      // settles, and a later socket error with zero listeners is an unhandled
      // 'error' event that crashes the process.
      ws.on("error", () => undefined);

      try {
        await connectOrThrow("AssemblyAI TTS", connectError, () => waitForOpen(ws));
      } catch (err) {
        // Failed connect: close the socket before rethrowing so it can't
        // linger half-open (late errors land in the placeholder above).
        try {
          ws.close();
        } catch {
          // Socket already broken — nothing left to release.
        }
        throw err;
      }

      const emitter: Emitter<TtsEvents> = createNanoEvents<TtsEvents>();
      let doneEmitted = true; // no turn in flight until the first sendText

      const shell = createSessionShell({
        makeStreamError: (msg) => makeTtsError("tts_stream_error", msg),
        emitError: (err) => emitter.emit("error", err),
        teardown: () => {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({ type: "Terminate" }));
            } catch {
              // Already going away; the close below is what matters.
            }
          }
          try {
            ws.close();
          } catch {
            // Socket already broken — still drop the listeners below.
          }
          // Drop handlers so their closures don't stay reachable via the
          // socket if `ws` outlives this session.
          ws.removeAllListeners();
        },
      });

      const emitDoneOnce = () => {
        if (doneEmitted || shell.isClosed()) return;
        doneEmitted = true;
        emitter.emit("done");
      };

      ws.on("message", (raw: WebSocket.Data) => {
        if (shell.isClosed()) return;
        handleMessage(raw, emitter, emitDoneOnce, shell.streamError);
      });
      ws.on("error", (err: Error) => shell.onSocketError(err));
      ws.on("close", () => {
        if (shell.isClosed()) return;
        // Unexpected server-side close: release the turn so the pipeline
        // doesn't wait for an utterance that will never complete.
        emitDoneOnce();
      });

      closeOnAbort(openOpts.signal, shell.close);

      const send = (payload: Record<string, unknown>): boolean => {
        if (shell.isClosed() || ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify(payload));
        return true;
      };

      const session: AssemblyAITtsSession = {
        sendText(text: string) {
          if (text.length === 0) return;
          if (send({ type: "Generate", text })) doneEmitted = false;
        },

        flush() {
          send({ type: "Flush" });
        },

        cancel() {
          if (shell.isClosed()) return;
          // There is no server-side "discard buffered audio" frame, so the
          // guard against a cancelled turn's audio leaking into the next one
          // is the pipeline's own: it stops forwarding on `done`. Emit it
          // synchronously — the orchestrator's state machine advances on
          // `done`, and barge-in must not be microtask-deferred.
          emitDoneOnce();
        },

        on(event, fn) {
          return emitter.on(event, fn);
        },

        close: shell.close,

        _ws: ws,
      };

      return session;
    },
  };
}
