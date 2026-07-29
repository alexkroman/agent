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
 *
 * **Cancel.** The protocol has no discard/cancel frame, so a mid-turn
 * `cancel()` drops the whole connection and reconnects: text Generate'd but
 * never Flush'ed would otherwise sit in the server-side buffer and be spliced
 * into the NEXT turn's synthesis on its Flush, and Audio frames already in
 * flight would audibly resume the interrupted reply. The cancelled socket's
 * listeners are detached before it closes, so its late frames (audio, a stale
 * `is_final`/`FlushDone` that could end the next turn early, the close
 * itself) are unobservable. Text sent while the replacement socket is still
 * connecting is queued and flushed to it on open.
 */

import { createNanoEvents, type Emitter } from "nanoevents";
import WebSocket from "ws";
import {
  ASSEMBLYAI_TTS_API_KEY_ENV,
  ASSEMBLYAI_TTS_DEFAULT_VOICE,
  ASSEMBLYAI_TTS_HOST,
  type AssemblyAITtsOptions,
  assemblyAITtsLanguageCodes,
  resolveAssemblyAITtsLanguage,
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
  createGuardedWs,
  createSessionShell,
  dropSocket as dropSocketShared,
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

function buildUrl(
  opts: AssemblyAITtsOptions,
  sampleRate: number,
  fail: (message: string) => Error,
): string {
  const params = new URLSearchParams({
    voice: opts.voice ?? ASSEMBLYAI_TTS_DEFAULT_VOICE,
    sample_rate: String(sampleRate),
  });
  // Omitted unless set: every voice speaks one language, so the server infers
  // it, and a mismatched pair is worse than no hint.
  if (opts.language) {
    // The wire wants `spanish`, not `es` — see ASSEMBLYAI_TTS_LANGUAGES. An
    // unsupported code must throw here: the service's own refusal arrives
    // in-band after the socket is open, which leaves the session "ready" and
    // silently mute instead of failing it.
    const language = resolveAssemblyAITtsLanguage(opts.language);
    if (language === undefined) {
      throw fail(
        `AssemblyAI TTS: unsupported language ${JSON.stringify(opts.language)} ` +
          `(supported: ${assemblyAITtsLanguageCodes().join(", ")})`,
      );
    }
    params.set("language", language);
  }
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
      // Built once so an unsupported language throws here, at open, rather
      // than on a cancel-triggered reconnect mid-conversation.
      const url = buildUrl(opts, sampleRate, connectError);

      const connect = (): WebSocket =>
        // Raw key, not `Bearer` — see the module doc. The guard listener
        // protects against a late socket error with zero listeners crashing
        // the process.
        createGuardedWs(
          () => new WebSocket(url, { headers: { Authorization: apiKey } }),
          connectError,
          "AssemblyAI TTS",
        );

      let ws = connect();
      try {
        await connectOrThrow("AssemblyAI TTS", connectError, () => waitForOpen(ws));
      } catch (err) {
        // Failed connect: close the socket before rethrowing so it can't
        // linger half-open (late errors land in the guard listener).
        dropSocketShared(ws);
        throw err;
      }

      const emitter: Emitter<TtsEvents> = createNanoEvents<TtsEvents>();
      let doneEmitted = true; // no turn in flight until the first sendText
      // Non-null while a post-cancel replacement socket is connecting: frames
      // queue here and flush to it on open, preserving order.
      let queued: Record<string, unknown>[] | null = null;

      /** Detach + politely close a socket without emitting anything for it. */
      const dropSocket = (socket: WebSocket): void =>
        dropSocketShared(socket, () => socket.send(JSON.stringify({ type: "Terminate" })));

      const shell = createSessionShell({
        makeStreamError: (msg) => makeTtsError("tts_stream_error", msg),
        emitError: (err) => emitter.emit("error", err),
        // `ws` is read at teardown time so a close after a cancel-reconnect
        // releases the replacement socket, not the one already dropped.
        teardown: () => dropSocket(ws),
      });

      const emitDoneOnce = () => {
        if (doneEmitted || shell.isClosed()) return;
        doneEmitted = true;
        emitter.emit("done");
      };

      const attach = (socket: WebSocket): void => {
        socket.on("message", (raw: WebSocket.Data) => {
          if (shell.isClosed()) return;
          handleMessage(raw, emitter, emitDoneOnce, shell.streamError);
        });
        socket.on("error", (err: Error) => shell.onSocketError(err));
        socket.on("close", (code: number) => {
          if (shell.isClosed()) return;
          // Unexpected server-side close: release the turn so the pipeline
          // doesn't wait for an utterance that will never complete.
          emitDoneOnce();
          // A non-normal close (idle kick, 1011, deploy) leaves the session
          // alive but every later `send` silently dropped by the readyState
          // guard — surface it so the session fails loudly rather than going
          // permanently, silently mute.
          if (code !== 1000) {
            shell.streamError(`AssemblyAI TTS: socket closed ${code}`);
          }
        });
      };
      attach(ws);

      /** Replace the connection after a mid-turn cancel — see the module doc. */
      const reconnect = (): void => {
        dropSocket(ws);
        const frames: Record<string, unknown>[] = [];
        queued = frames;
        let next: WebSocket;
        try {
          next = connect();
        } catch (cause) {
          queued = null;
          shell.streamError(errorMessage(cause));
          return;
        }
        ws = next;
        void waitForOpen(next).then(
          () => {
            // Superseded (closed, or cancelled again) — not the live socket.
            if (shell.isClosed() || ws !== next) return;
            attach(next);
            queued = null;
            for (const frame of frames) next.send(JSON.stringify(frame));
          },
          (cause: unknown) => {
            if (shell.isClosed() || ws !== next) return;
            queued = null;
            shell.streamError(
              `AssemblyAI TTS: reconnect after cancel failed: ${errorMessage(cause)}`,
            );
          },
        );
      };

      const send = (payload: Record<string, unknown>): boolean => {
        if (shell.isClosed()) return false;
        if (queued !== null) {
          queued.push(payload);
          return true;
        }
        if (ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify(payload));
        return true;
      };

      closeOnAbort(openOpts.signal, shell.close);

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
          const turnInFlight = !doneEmitted;
          // Emit `done` synchronously — the orchestrator's state machine
          // advances on it, and barge-in must not be microtask-deferred.
          emitDoneOnce();
          // Idempotent: nothing sent since the last done means nothing is
          // buffered server-side and no audio is in flight.
          if (!turnInFlight) return;
          if (queued !== null) {
            // The replacement socket is still connecting, so the cancelled
            // turn's frames never left the process — dropping them IS the cancel.
            queued.length = 0;
            return;
          }
          reconnect();
        },

        on(event, fn) {
          return emitter.on(event, fn);
        },

        close: shell.close,

        get _ws() {
          return ws;
        },
      };

      return session;
    },
  };
}
