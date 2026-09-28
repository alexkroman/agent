// Copyright 2026 the AAI authors. MIT license.
/**
 * Host opener for `localStt()` — a speech model served on the developer's own
 * machine. The wire protocol is the one documented on `localStt` in
 * `@alexkroman1/aai/experimental`; the server owns endpointing, so a `final`
 * frame is already the end of the turn and is forwarded as-is.
 */

import type { LocalSttOptions } from "@alexkroman1/aai/experimental";
import { resolveLocalSttSettings } from "@alexkroman1/aai/host-internal";
import { isRecord, omitUndefined, safeJsonParse } from "@alexkroman1/aai/utils";
import { createNanoEvents, type Emitter } from "nanoevents";
import WebSocket from "ws";
import { PROVIDER_WS_OPTIONS } from "../../_ws.ts";
import { dropSocket, openGuardedWs, wireSttPcmSocket } from "../_socket.ts";
import { createSttSessionShell } from "../_utils.ts";
import {
  createSttError,
  type SttEvents,
  type SttOpener,
  type SttOpenOptions,
  type SttSession,
  type SttTurnMeta,
} from "../openers.ts";

/** The first frame: everything the server needs before audio arrives. */
export function buildLocalConfigFrame(
  opts: LocalSttOptions,
  sampleRate: number,
  sttPrompt: string | undefined,
): Record<string, unknown> {
  const settings = resolveLocalSttSettings(opts);
  const frame: Record<string, unknown> = {
    type: "config",
    sample_rate: sampleRate,
    min_turn_silence_ms: settings.minTurnSilenceMs,
    max_turn_silence_ms: settings.maxTurnSilenceMs,
    ...omitUndefined({ language: settings.language }),
  };
  // As AssemblyAI's: an empty `sttPrompt` sends no prompt at all.
  if (sttPrompt) frame.prompt = sttPrompt;
  return frame;
}

type LocalEmit = {
  partial: (text: string, meta?: SttTurnMeta) => void;
  final: (text: string, meta?: SttTurnMeta) => void;
  streamError: (message: string) => void;
};

/**
 * Route one server frame. Probed field by field, never trusted: this runs in a
 * socket `message` handler, where a throw is an uncaughtException on the host.
 */
export function handleLocalFrame(raw: string, emit: LocalEmit): void {
  const msg = safeJsonParse(raw);
  if (!isRecord(msg)) return;
  const text = typeof msg.text === "string" ? msg.text : "";
  const confidence = msg.end_of_turn_confidence;
  const meta: SttTurnMeta | undefined =
    typeof confidence === "number" ? { endOfTurnConfidence: confidence } : undefined;
  switch (msg.type) {
    case "partial":
      if (text.length > 0) emit.partial(text, meta);
      return;
    case "final":
      // An empty final is a turn the server heard only noise in; committing
      // it would run the LLM on nothing.
      if (text.trim().length > 0) emit.final(text, meta);
      return;
    case "error":
      emit.streamError(
        `Local STT error: ${typeof msg.message === "string" ? msg.message : "unknown"}`,
      );
      return;
    default:
      return;
  }
}

/**
 * How the opener constructs its socket — a seam so the unit tier can drive the
 * whole session against a fake instead of `vi.mock("ws")`.
 */
export type CreateLocalSttSocket = (url: string, options: WebSocket.ClientOptions) => WebSocket;

const createWs: CreateLocalSttSocket = (url, options) => new WebSocket(url, options);

export function openLocalStt(
  opts: LocalSttOptions = {},
  createSocket: CreateLocalSttSocket = createWs,
): SttOpener {
  return {
    name: "local",
    async open(openOpts: SttOpenOptions): Promise<SttSession> {
      const settings = resolveLocalSttSettings(opts);
      const emitter: Emitter<SttEvents> = createNanoEvents<SttEvents>();
      // A key is optional here, unlike every cloud opener: a server on
      // loopback normally takes none, so an empty one sends no header.
      const headers: Record<string, string> = openOpts.apiKey
        ? { Authorization: `Bearer ${openOpts.apiKey}` }
        : {};

      const ws = await openGuardedWs({
        create: () => createSocket(settings.url, { ...PROVIDER_WS_OPTIONS, headers }),
        label: `Local STT (${settings.url})`,
        makeConnectError: (msg) => createSttError("stt_connect_failed", msg),
        signal: openOpts.signal,
        onOpen: (socket) =>
          socket.send(
            JSON.stringify(buildLocalConfigFrame(opts, openOpts.sampleRate, openOpts.sttPrompt)),
          ),
      });

      const shell = createSttSessionShell({ emitter, teardown: () => dropSocket(ws) });
      const emit: LocalEmit = {
        partial: (text, meta) => shell.emit("partial", text, meta),
        final: (text, meta) => shell.emit("final", text, meta),
        streamError: (message) => shell.streamError(message),
      };

      ws.on("message", (raw: WebSocket.RawData, isBinary: boolean) => {
        if (shell.isClosed() || isBinary) return;
        handleLocalFrame(raw.toString(), emit);
      });
      const sendAudio = wireSttPcmSocket(ws, shell, openOpts.signal, "Local STT");
      const sendJson = (frame: Record<string, unknown>): void => {
        if (shell.isClosed() || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify(frame));
      };
      let currentMinTurnSilenceMs = settings.minTurnSilenceMs;

      return {
        sendAudio,
        on: shell.on,
        close: shell.close,
        updateEndpointing(minTurnSilenceMs: number) {
          // Clamped to the ceiling, as AssemblyAI's is: a floor above the
          // ceiling would end every turn on the content-blind fallback.
          const bounded = Math.round(
            Math.max(1, Math.min(minTurnSilenceMs, settings.maxTurnSilenceMs)),
          );
          if (bounded === currentMinTurnSilenceMs) return;
          currentMinTurnSilenceMs = bounded;
          sendJson({ type: "update", min_turn_silence_ms: bounded });
        },
        forceEndOfTurn() {
          sendJson({ type: "force_endpoint" });
        },
      };
    },
  };
}
