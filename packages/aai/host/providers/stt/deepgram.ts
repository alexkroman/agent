// Copyright 2026 the AAI authors. MIT license.
/**
 * Deepgram Nova streaming STT opener (host-only).
 *
 * The user-facing descriptor factory (`deepgram(...)`) lives in
 * `sdk/providers/stt/deepgram.ts`. This module is the host-side
 * counterpart: it takes the descriptor options + an API key and
 * returns an {@link SttOpener} that the pipeline session drives.
 *
 * Default model: `"nova-3"`. Any string is forwarded verbatim to the SDK.
 *
 * This adapter targets the Deepgram SDK v5 (`@deepgram/sdk@^5`). The v5
 * streaming API is:
 *   `client.listen.v1.connect(args)` → `Promise<V1Socket>`
 * followed by:
 *   `socket.connect()` + `socket.waitForOpen()` to establish the connection.
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

// V1Socket type from the Deepgram SDK (accessed through the listen namespace).
type V1Socket = Awaited<ReturnType<InstanceType<typeof DeepgramClient>["listen"]["v1"]["connect"]>>;

/** Internal: SttSession with a test-only handle to the raw SDK socket. */
export interface DeepgramSession extends SttSession {
  /** @internal Test-only: exposes the underlying SDK socket for fixture replay. */
  readonly _connection: V1Socket;
}

type MessagePayload =
  | listen.ListenV1Results
  | listen.ListenV1Metadata
  | listen.ListenV1UtteranceEnd
  | listen.ListenV1SpeechStarted;

/**
 * Handle an incoming Deepgram transcript message, emitting `partial` or
 * `final` events on the emitter. Empty transcripts are silently dropped.
 */
function handleMessage(data: MessagePayload, closed: boolean, emitter: Emitter<SttEvents>): void {
  if (closed) return;
  if (data.type !== "Results") return;
  const result = data as listen.ListenV1Results;
  const text = result.channel?.alternatives?.[0]?.transcript ?? "";
  if (result.is_final) {
    if (text.length > 0) emitter.emit("final", text);
  } else if (text.length > 0) {
    emitter.emit("partial", text);
  }
}

/** Wire Deepgram socket events onto the nanoevents emitter. */
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

/** Wire the AbortSignal to the close function. */
function wireAbortSignal(signal: AbortSignal, close: () => Promise<void>): void {
  if (signal.aborted) {
    void close();
  } else {
    signal.addEventListener("abort", () => void close(), { once: true });
  }
}

/** Build an {@link SttOpener} from resolved Deepgram descriptor options. */
export function openDeepgram(opts: DeepgramOptions = {}): SttOpener {
  return {
    name: "deepgram",
    async open(openOpts: SttOpenOptions): Promise<SttSession> {
      const apiKey = openOpts.apiKey || process.env.DEEPGRAM_API_KEY;
      if (!apiKey) {
        throw makeSttError(
          "stt_auth_failed",
          "Deepgram STT: missing API key. Set DEEPGRAM_API_KEY in the agent env.",
        );
      }

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
          `Deepgram STT: connect failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }

      const emitter: Emitter<SttEvents> = createNanoEvents<SttEvents>();
      let closed = false;

      wireSocketEvents(connection, emitter, () => closed);

      // Actually open the WebSocket connection (registers internal handlers
      // and initiates the TCP/TLS handshake).
      connection.connect();
      try {
        await connection.waitForOpen();
      } catch (cause) {
        throw makeSttError(
          "stt_connect_failed",
          `Deepgram STT: WebSocket open failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }

      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        try {
          connection.close();
        } catch {
          // Swallow: the caller has already decided to tear down.
        }
      };

      wireAbortSignal(openOpts.signal, close);

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
