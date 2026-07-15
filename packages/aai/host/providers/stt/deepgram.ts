// Copyright 2026 the AAI authors. MIT license.
/**
 * Deepgram Nova streaming STT opener (host-only).
 *
 * Targets Deepgram SDK v5: `client.listen.v1.connect(args)` returns a
 * socket; `socket.connect()` + `socket.waitForOpen()` establish it.
 */

import { DeepgramClient, type listen } from "@deepgram/sdk";
import { createNanoEvents, type Emitter } from "nanoevents";
import { DEEPGRAM_API_KEY_ENV, type DeepgramOptions } from "../../../sdk/providers/stt/deepgram.ts";
import {
  makeSttError,
  type SttEvents,
  type SttOpener,
  type SttOpenOptions,
  type SttSession,
} from "../../../sdk/providers.ts";
import {
  closeOnAbort,
  connectOrThrow,
  createSessionShell,
  requireApiKey,
  type SessionShell,
} from "../_utils.ts";

type V1Socket = Awaited<ReturnType<InstanceType<typeof DeepgramClient>["listen"]["v1"]["connect"]>>;

export interface DeepgramSession extends SttSession {
  /** @internal Test-only: exposes the underlying SDK socket for fixture replay. */
  readonly _connection: V1Socket;
}

type MessagePayload =
  | listen.ListenV1Results
  | listen.ListenV1Metadata
  | listen.ListenV1UtteranceEnd
  | listen.ListenV1SpeechStarted;

function handleMessage(data: MessagePayload, closed: boolean, emitter: Emitter<SttEvents>): void {
  if (closed || data.type !== "Results") return;
  const text = data.channel?.alternatives?.[0]?.transcript ?? "";
  if (text.length === 0) return;
  emitter.emit(data.is_final ? "final" : "partial", text);
}

function wireSocketEvents(
  connection: V1Socket,
  emitter: Emitter<SttEvents>,
  shell: SessionShell,
): void {
  connection.on("message", (data: MessagePayload) =>
    handleMessage(data, shell.isClosed(), emitter),
  );
  connection.on("error", (err: Error) => shell.onSocketError(err));
  connection.on("close", (event: { code?: number }) => shell.onSocketClose(event?.code));
}

export function openDeepgram(opts: DeepgramOptions = {}): SttOpener {
  return {
    name: "deepgram",
    async open(openOpts: SttOpenOptions): Promise<SttSession> {
      const apiKey = requireApiKey(openOpts.apiKey, DEEPGRAM_API_KEY_ENV, "Deepgram STT", (msg) =>
        makeSttError("stt_auth_failed", msg),
      );
      const connectError = (msg: string) => makeSttError("stt_connect_failed", msg);

      const client = new DeepgramClient({ apiKey });
      const connection = await connectOrThrow("Deepgram STT", connectError, () =>
        client.listen.v1.connect({
          model: opts.model ?? "nova-3",
          language: opts.language ?? "en",
          encoding: "linear16",
          sample_rate: openOpts.sampleRate,
          channels: 1,
          interim_results: "true",
          smart_format: "true",
          endpointing: 300,
          utterance_end_ms: "1000",
          // Pass the API key explicitly as the Authorization header so the
          // WebSocket connection authenticates even without env var fallback.
          Authorization: apiKey,
        }),
      );

      const emitter: Emitter<SttEvents> = createNanoEvents<SttEvents>();
      const shell = createSessionShell({
        makeStreamError: (msg) => makeSttError("stt_stream_error", msg),
        emitError: (err) => emitter.emit("error", err),
        teardown: () => connection.close(),
      });

      wireSocketEvents(connection, emitter, shell);

      connection.connect();
      await connectOrThrow(
        "Deepgram STT",
        connectError,
        () => connection.waitForOpen(),
        "WebSocket open failed",
      );

      closeOnAbort(openOpts.signal, shell.close);

      const session: DeepgramSession = {
        sendAudio(pcm: Int16Array) {
          if (shell.isClosed()) return;
          connection.sendMedia(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
        },
        on(event, fn) {
          return emitter.on(event, fn);
        },
        close: shell.close,
        _connection: connection,
      };

      return session;
    },
  };
}
