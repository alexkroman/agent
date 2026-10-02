// Copyright 2026 the AAI authors. MIT license.
/**
 * Deepgram Nova streaming STT opener (host-only).
 *
 * Targets Deepgram SDK v5: `client.listen.v1.connect(args)` returns a
 * socket; `socket.connect()` + `socket.waitForOpen()` establish it.
 */

import { DEEPGRAM_API_KEY_ENV, resolveDeepgramSttSettings } from "@alexkroman1/aai/host-internal";
import type { DeepgramSttOptions } from "@alexkroman1/aai/stt";
import { DeepgramClient, type listen } from "@deepgram/sdk";
import { createNanoEvents, type Emitter } from "nanoevents";
import { createAudioSendGate } from "../../_audio-gate.ts";
import { pcm16ToBytes } from "../../_pcm.ts";
import {
  closeOnAbort,
  connectOrThrow,
  createSttSessionShell,
  requireApiKey,
  type SessionShell,
} from "../_utils.ts";
import {
  createSttError,
  type SttEvents,
  type SttOpener,
  type SttOpenOptions,
  type SttSession,
} from "../openers.ts";

type V1Connect = InstanceType<typeof DeepgramClient>["listen"]["v1"]["connect"];

type MessagePayload =
  | listen.ListenV1Results
  | listen.ListenV1Metadata
  | listen.ListenV1UtteranceEnd
  | listen.ListenV1SpeechStarted;

/**
 * The slice of the SDK's `V1Socket` this adapter drives.
 *
 * @internal
 */
export interface DeepgramSocket {
  on(event: "message", fn: (data: MessagePayload) => void): void;
  on(event: "error", fn: (err: Error) => void): void;
  on(event: "close", fn: (event: { code?: number }) => void): void;
  connect(): unknown;
  waitForOpen(): Promise<unknown>;
  close(): void;
  sendMedia(data: ArrayBufferView): void;
  /** The underlying ws, read for its buffer; absent on a fake. */
  readonly socket?: { readonly bufferedAmount?: number } | undefined;
}

/**
 * Dial one socket — the seam a spec hands a fake through (see
 * {@link openDeepgram}).
 *
 * @internal
 */
export type DeepgramConnect = (
  apiKey: string,
  args: Parameters<V1Connect>[0],
) => Promise<DeepgramSocket>;

/** The production {@link DeepgramConnect}: the real SDK client. */
const sdkConnect: DeepgramConnect = (apiKey, args) =>
  new DeepgramClient({ apiKey }).listen.v1.connect(args);

export interface DeepgramSession extends SttSession {
  /** @internal Test-only: exposes the underlying SDK socket for fixture replay. */
  readonly _connection: DeepgramSocket;
}

// Emits through the shell, which owns the closed latch and the throw
// containment: this fires from inside the SDK's own socket handler, where a
// listener that throws would escape as an uncaughtException.
function handleMessage(data: MessagePayload, shell: SessionShell<SttEvents>): void {
  if (data.type !== "Results") return;
  const text = data.channel?.alternatives?.[0]?.transcript ?? "";
  if (text.length === 0) return;
  shell.emit(data.is_final ? "final" : "partial", text);
}

function wireSocketEvents(connection: DeepgramSocket, shell: SessionShell<SttEvents>): void {
  connection.on("message", (data: MessagePayload) => handleMessage(data, shell));
  connection.on("error", (err: Error) => shell.onSocketError(err));
  connection.on("close", (event: { code?: number }) => shell.onSocketClose(event?.code));
}

export function openDeepgram(
  opts: DeepgramSttOptions = {},
  connect: DeepgramConnect = sdkConnect,
): SttOpener {
  return {
    name: "deepgram",
    async open(openOpts: SttOpenOptions): Promise<SttSession> {
      const apiKey = requireApiKey(openOpts.apiKey, DEEPGRAM_API_KEY_ENV, "Deepgram STT", (msg) =>
        createSttError("stt_auth_failed", msg),
      );
      const connectError = (msg: string) => createSttError("stt_connect_failed", msg);

      const settings = resolveDeepgramSttSettings(opts);
      const connection = await connectOrThrow("Deepgram STT", connectError, () =>
        connect(apiKey, {
          model: settings.model,
          language: settings.language,
          encoding: "linear16",
          sample_rate: openOpts.sampleRate,
          channels: 1,
          interim_results: "true",
          smart_format: "true",
          endpointing: settings.endpointingMs,
          utterance_end_ms: "1000",
          // Pass the API key explicitly as the Authorization header so the
          // WebSocket connection authenticates even without env var fallback.
          Authorization: apiKey,
        }),
      );

      const emitter: Emitter<SttEvents> = createNanoEvents<SttEvents>();
      const shell = createSttSessionShell({
        emitter,
        teardown: () => connection.close(),
      });

      wireSocketEvents(connection, shell);

      try {
        connection.connect();
        await connectOrThrow(
          "Deepgram STT",
          connectError,
          () => connection.waitForOpen(),
          "WebSocket open failed",
        );
      } catch (err) {
        // Open failed: release the half-open SDK socket instead of leaking
        // it. shell.close() is idempotent and swallows teardown errors.
        await shell.close();
        throw err;
      }

      closeOnAbort(openOpts.signal, shell.close);

      // Drop audio frames while the provider link is stalled — mic audio is
      // real-time paced and loss-tolerant; see _audio-gate.ts. The SDK's
      // socket wrapper exposes the underlying ws buffer; fakes (and future
      // SDK shapes) without it skip the gate.
      const audioGate = createAudioSendGate({
        bufferedAmount: () => connection.socket?.bufferedAmount,
        label: "Deepgram STT",
      });

      const session: DeepgramSession = {
        sendAudio(pcm: Int16Array) {
          if (shell.isClosed() || audioGate.shouldDrop()) return;
          connection.sendMedia(pcm16ToBytes(pcm));
        },
        on: shell.on,
        close: shell.close,
        _connection: connection,
      };

      return session;
    },
  };
}
