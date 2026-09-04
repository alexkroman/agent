// Copyright 2026 the AAI authors. MIT license.
/**
 * Rime TTS opener (host-only).
 *
 * Connects to Rime's `ws2` JSON WebSocket endpoint with one long-lived
 * connection per session. Client → server: `{ text }` appends to the
 * synthesis buffer, `{ operation: "clear" }` drops it (barge-in). We never
 * send `eos` since it tears down the WS — `flush()` instead sends a
 * trailing `"."` to force synthesis of any text buffered behind missing
 * terminal punctuation while keeping the connection reusable.
 *
 * Server → client: `{ type: "chunk", data: <base64 PCM16 LE> }` carries
 * audio; `timestamps` is ignored; `error` surfaces as `tts_stream_error`.
 * The `audioFormat=pcm` query param at the negotiated `sampleRate` returns
 * raw PCM16 LE that we view as a zero-copy `Int16Array`.
 */

import {
  makeTtsError,
  RIME_API_KEY_ENV,
  resolveRimeTtsSettings,
  type TtsEvents,
  type TtsOpener,
  type TtsOpenOptions,
  type TtsSession,
  WS_OPEN,
} from "@alexkroman1/aai/host-internal";
import type { RimeTtsOptions } from "@alexkroman1/aai/tts";
import { safeJsonParse } from "@alexkroman1/aai/utils";
import { createNanoEvents, type Emitter } from "nanoevents";
import WebSocket from "ws";
import { base64ToUint8 } from "../../_base64.ts";
import { bytesToPcm16 } from "../../_pcm.ts";
import { createRestartableTimer } from "../../_timer.ts";
import { PROVIDER_WS_OPTIONS } from "../../_ws.ts";
import { dropSocket, openGuardedWs } from "../_socket.ts";
import {
  assertPcm16Rate,
  closeOnAbort,
  createDoneLatch,
  createTtsSessionShell,
  requireApiKey,
  type SessionShell,
} from "../_utils.ts";

export interface RimeSession extends TtsSession {
  /** @internal Test-only: exposes the underlying raw WebSocket. */
  readonly _ws: WebSocket;
}

interface RimeMessage {
  type: "chunk" | "timestamps" | "error" | string;
  data?: string;
  contextId?: string | null;
  message?: string;
}

const QUIESCENCE_MS = 500;

// Greetings and short replies emit `flush()` immediately after `sendText()`,
// so audio TTFB easily exceeds QUIESCENCE_MS. Wait longer for the FIRST
// chunk; subsequent chunks revert to the shorter quiescence window.
const FIRST_AUDIO_TIMEOUT_MS = 5000;

// Extracted to a top-level function to keep `open()` under the cognitive
// complexity limit; session state is threaded through via the ref callbacks.
//
// Emits through `shell`, never the raw emitter: this runs inside a socket
// 'message' handler, where a throw from a downstream listener escapes into
// Node's EventEmitter as an uncaughtException — taking down a multi-tenant host
// rather than one session.
function handleRimeMessage(
  raw: WebSocket.Data,
  shell: SessionShell<TtsEvents>,
  armQuiescence: () => void,
  isActiveTimer: () => boolean,
): void {
  const msg = safeJsonParse(typeof raw === "string" ? raw : raw.toString()) as
    | RimeMessage
    | undefined;
  if (msg === undefined) return;

  if (msg.type === "chunk" && typeof msg.data === "string") {
    const pcm = bytesToPcm16(base64ToUint8(msg.data));
    if (pcm.length > 0) {
      shell.emit("audio", pcm);
      // Each chunk resets the quiescence window so `done` fires only after
      // audio stops — applies to both the first-audio and post-chunk timers.
      if (isActiveTimer()) armQuiescence();
    }
    return;
  }
  if (msg.type === "error") {
    shell.streamError(`Rime TTS: ${msg.message ?? "unknown error"}`);
  }
}

export function openRime(opts: RimeTtsOptions): TtsOpener {
  return {
    name: "rime",
    async open(openOpts: TtsOpenOptions): Promise<TtsSession> {
      const apiKey = requireApiKey(openOpts.apiKey, RIME_API_KEY_ENV, "Rime TTS", (msg) =>
        makeTtsError("tts_auth_failed", msg),
      );
      const connectError = (msg: string) => makeTtsError("tts_connect_failed", msg);

      const sampleRate = assertPcm16Rate(openOpts.sampleRate, "Rime TTS", connectError);
      const { model, language: lang, voice } = resolveRimeTtsSettings(opts);

      const url = `wss://users-ws.rime.ai/ws2?speaker=${encodeURIComponent(voice)}&modelId=${encodeURIComponent(model)}&audioFormat=pcm&samplingRate=${sampleRate}&lang=${encodeURIComponent(lang)}`;

      // Bounded and abort-wired: an upgrade that black-holes must not leave
      // `open()` pending with a socket nobody owns — see `openGuardedWs`, which
      // also owns registering the pre-connect zero-listener error guard.
      const ws = await openGuardedWs({
        create: () =>
          new WebSocket(url, {
            headers: { Authorization: `Bearer ${apiKey}` },
            ...PROVIDER_WS_OPTIONS,
          }),
        label: "Rime TTS",
        makeConnectError: connectError,
        signal: openOpts.signal,
      });

      const emitter: Emitter<TtsEvents> = createNanoEvents<TtsEvents>();
      // One timer serving both windows: whichever was armed last wins, which is
      // the intent — the first-audio deadline is replaced by the quiescence
      // deadline as soon as audio starts flowing.
      const quiescence = createRestartableTimer(() => emitDoneOnce());

      const shell = createTtsSessionShell({
        emitter,
        teardown: () => {
          quiescence.clear();
          // Detach and close, leaving a zero-listener error guard so a late
          // error during the close handshake can't crash the process.
          dropSocket(ws);
        },
      });

      const doneLatch = createDoneLatch(shell, () => shell.emit("done"));
      const emitDoneOnce = () => {
        quiescence.clear();
        doneLatch.emitOnce();
      };

      const armQuiescence = () => quiescence.arm(QUIESCENCE_MS);
      const armFirstAudioTimer = () => quiescence.arm(FIRST_AUDIO_TIMEOUT_MS);

      ws.on("message", (raw: WebSocket.Data) => {
        if (shell.isClosed()) return;
        handleRimeMessage(raw, shell, armQuiescence, quiescence.pending);
      });

      ws.on("error", (err: Error) => shell.onSocketError(err));

      ws.on("close", (code: number) => {
        if (shell.isClosed()) return;
        // Release the turn either way so the pipeline doesn't hang. But a
        // non-normal close (idle kick, 1011, deploy) means every later
        // `sendText` will be silently dropped by the readyState guard and the
        // caller would hear nothing with no error — surface it so the session
        // fails loudly instead of dying silent.
        emitDoneOnce();
        if (code !== 1000) {
          shell.streamError(`Rime TTS: socket closed ${code}`);
        }
      });

      closeOnAbort(openOpts.signal, shell.close);

      const session: RimeSession = {
        sendText(text: string) {
          if (shell.isClosed() || text.length === 0) return;
          if (ws.readyState !== WS_OPEN) return;
          doneLatch.rearm();
          ws.send(JSON.stringify({ text }));
        },

        flush() {
          if (shell.isClosed()) return;
          if (ws.readyState !== WS_OPEN) return;
          // Force synthesis of any text buffered behind missing terminal
          // punctuation: a trailing `"."` keeps the WS reusable, whereas
          // the JSON `eos` operation would close it and require a
          // reconnect every turn.
          ws.send(JSON.stringify({ text: "." }));
          armFirstAudioTimer();
        },

        cancel() {
          if (shell.isClosed()) return;
          if (ws.readyState === WS_OPEN) {
            ws.send(JSON.stringify({ operation: "clear" }));
          }
          // Emit `done` synchronously — the orchestrator's state machine
          // advances on `done`, and barge-in must not be microtask-deferred.
          emitDoneOnce();
        },

        on: shell.on,

        close: shell.close,

        _ws: ws,
      };

      return session;
    },
  };
}
