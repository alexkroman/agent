// Copyright 2026 the AAI authors. MIT license.
/**
 * Cartesia one-shot synthesis client — a complete reply in, PCM16 bytes out.
 *
 * One HTTP request against Cartesia's `/tts/bytes` endpoint, versus opening
 * a streaming WebSocket context and draining it. Zero dependencies (plain
 * `fetch`), mirroring `sdk/providers/stt/assemblyai-sync.ts`, so it runs on
 * the host, in Deno, and in the guest sandbox alike.
 *
 * API reference: https://docs.cartesia.ai/api-reference/tts/bytes
 */

import { httpErrorDetail, resolveFetch } from "../_http.ts";

/** Cartesia bytes-synthesis endpoint. */
export const CARTESIA_TTS_BYTES_URL = "https://api.cartesia.ai/tts/bytes";

/** API version pinned via the `Cartesia-Version` header. */
export const CARTESIA_API_VERSION = "2025-11-04";

/** Options for {@link syncSynthesize}. */
export type SyncSynthesizeOptions = {
  /** The complete text to speak. */
  text: string;
  /** Cartesia voice ID. */
  voice: string;
  /** Model ID. Defaults to `"sonic-2"` (same as the streaming opener). */
  model?: string | undefined;
  /** Spoken language hint. Defaults to `"en"`. */
  language?: string | undefined;
  /** Output sample rate in Hz for the raw PCM16LE response. */
  sampleRate: number;
  /** Cartesia API key (sent as a Bearer token). */
  apiKey: string;
  /** Fetch implementation override (tests / proxied environments). */
  fetch?: typeof globalThis.fetch | undefined;
  signal?: AbortSignal | undefined;
};

/**
 * Synthesize one complete reply into mono PCM16LE bytes in a single
 * synchronous request — no WebSocket, no context management.
 *
 * @throws On a non-2xx response, with the API's error message (never the key).
 */
export async function syncSynthesize(opts: SyncSynthesizeOptions): Promise<Uint8Array> {
  const fetchFn = resolveFetch(opts.fetch);
  const resp = await fetchFn(CARTESIA_TTS_BYTES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Cartesia-Version": CARTESIA_API_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model_id: opts.model ?? "sonic-2",
      transcript: opts.text,
      voice: { mode: "id", id: opts.voice },
      output_format: {
        container: "raw",
        encoding: "pcm_s16le",
        sample_rate: opts.sampleRate,
      },
      language: opts.language ?? "en",
    }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!resp.ok) {
    const detail = await httpErrorDetail(resp);
    throw new Error(`Sync synthesis failed: HTTP ${resp.status}${detail ? ` (${detail})` : ""}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}
