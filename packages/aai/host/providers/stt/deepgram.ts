// Copyright 2026 the AAI authors. MIT license.
/**
 * Deepgram Nova streaming STT opener (host-only).
 *
 * Targets Deepgram SDK v5: `client.listen.v1.connect(args)` returns a
 * socket; `socket.connect()` + `socket.waitForOpen()` establish it.
 */

import { DeepgramClient, type listen } from "@deepgram/sdk";
import { createNanoEvents, type Emitter } from "nanoevents";
import type { DeepgramOptions } from "../../../sdk/providers/stt/deepgram.ts";
import {
  makeSttError,
  type SttEvents,
  type SttOpener,
  type SttOpenOptions,
  type SttSession,
} from "../../../sdk/providers.ts";
import { errorMessage } from "../../../sdk/utils.ts";
import { closeOnAbort, requireApiKey } from "../_utils.ts";

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
  getIsClosed: () => boolean,
): void {
  connection.on("message", (data: MessagePayload) => handleMessage(data, getIsClosed(), emitter));
  connection.on("error", (err: Error) => {
    if (getIsClosed()) return;
    emitter.emit("error", makeSttError("stt_stream_error", err?.message ?? String(err)));
  });
  connection.on("close", (event: { code?: number }) => {
    if (getIsClosed()) return;
    const code = event?.code;
    // 1000 = normal closure.
    if (code !== undefined && code !== 1000) {
      emitter.emit("error", makeSttError("stt_stream_error", `socket closed ${code}`));
    }
  });
}

export function openDeepgram(opts: DeepgramOptions = {}): SttOpener {
  return {
    name: "deepgram",
    async open(openOpts: SttOpenOptions): Promise<SttSession> {
      const apiKey = requireApiKey(openOpts.apiKey, "DEEPGRAM_API_KEY", "Deepgram STT", (msg) =>
        makeSttError("stt_auth_failed", msg),
      );

      const client = new DeepgramClient({ apiKey });
      let connection: V1Socket;
      try {
        connection = await client.listen.v1.connect({
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
        });
      } catch (cause) {
        throw makeSttError(
          "stt_connect_failed",
          `Deepgram STT: connect failed: ${errorMessage(cause)}`,
        );
      }

      const emitter: Emitter<SttEvents> = createNanoEvents<SttEvents>();
      let closed = false;

      wireSocketEvents(connection, emitter, () => closed);

      connection.connect();
      try {
        await connection.waitForOpen();
      } catch (cause) {
        throw makeSttError(
          "stt_connect_failed",
          `Deepgram STT: WebSocket open failed: ${errorMessage(cause)}`,
        );
      }

      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        try {
          connection.close();
        } catch {
          // Caller already decided to tear down.
        }
      };

      closeOnAbort(openOpts.signal, close);

      const session: DeepgramSession = {
        sendAudio(pcm: Int16Array) {
          if (closed) return;
          connection.sendMedia(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
        },
        on(event, fn) {
          return emitter.on(event, fn);
        },
        close,
        _connection: connection,
      };

      return session;
    },
  };
}
