// Copyright 2026 the AAI authors. MIT license.
/**
 * AssemblyAI Sync API client — synchronous transcription of short audio.
 *
 * One HTTP request, transcript back in the response: the preferred path for
 * short (under two minutes) audio files, versus opening a realtime streaming
 * session and replaying the file through it. Zero dependencies (plain
 * `fetch`), so it runs on the host, in Deno, and in the guest sandbox alike.
 *
 * **The multipart body is encoded by hand rather than with `FormData`**, and
 * that is load-bearing. `RuntimeOptions.fetch` decides which `fetch` gets the
 * body, and on the platform that is `safeFetch` → `pinnedFetch`, undici 8 from
 * `@alexkroman1/aai`'s own dependencies — while `globalThis.FormData` belongs
 * to the undici bundled into Node (`process.versions.undici`, v7). undici 8's
 * `extractBody` gates its multipart branch on an `instanceof` against its own
 * `FormData` class, so a foreign one misses every branch and is stringified:
 * the request went out as `Content-Type: text/plain` with the 17-byte body
 * `[object FormData]`, the API answered 415 ("request must be
 * multipart/form-data with an `audio` part"), and the browser saw
 * `Sync turn failed: HTTP 502`. Every sync turn was broken.
 *
 * A `Uint8Array` body plus an explicit `Content-Type` has no class identity to
 * disagree about, so it encodes identically on every `fetch` implementation.
 * A `Blob` body is brand-checked the same way, so neither it nor `FormData`
 * may come back as the request body (a `Blob` *input* is fine — it is read to
 * bytes before it reaches `fetch`).
 * Guarded by `host/sync-transcribe-wire.test.ts`, which posts through the real
 * pinned undici; specs that inject a fake fetch cannot see this class of bug.
 *
 * API reference: https://assemblyai.com/docs/api-reference/sync-api/transcribe
 */

import { httpErrorDetail, resolveFetch } from "../_http.ts";

/** US (default) Sync API endpoint. */
export const SYNC_TRANSCRIBE_URL = "https://sync.assemblyai.com/transcribe";

/** EU data-residency Sync API endpoint. */
export const SYNC_TRANSCRIBE_EU_URL = "https://sync.eu.assemblyai.com/transcribe";

/** Model identifier the Sync API routes on. */
export const SYNC_TRANSCRIBE_MODEL = "universal-3-5-pro";

/** The Sync API accepts at most this much audio; longer files need the
 *  pre-recorded (async) API or a realtime streaming session. */
export const MAX_SYNC_AUDIO_SECONDS = 120;

/** One transcribed word with its confidence (timestamps when requested). */
export type SyncTranscriptWord = {
  text: string;
  confidence: number;
  start?: number;
  end?: number;
};

/** Sync API response: the transcript plus per-word details. */
export type SyncTranscript = {
  text: string;
  words: SyncTranscriptWord[];
};

/** Options for {@link syncTranscribe}. */
export type SyncTranscribeOptions = {
  /** Audio payload: a WAV file's bytes, or raw S16LE PCM. */
  audio: Uint8Array | ArrayBuffer | Blob;
  /**
   * `"audio/wav"` (default — rate/channels read from the header) or
   * `"audio/pcm"` for raw S16LE, which requires `sampleRate` and `channels`.
   */
  contentType?: "audio/wav" | "audio/pcm" | undefined;
  /** Source sample rate in Hz. Required for `audio/pcm`. */
  sampleRate?: number | undefined;
  /** Channel count (stereo is down-mixed server-side). Required for `audio/pcm`. */
  channels?: 1 | 2 | undefined;
  /** AssemblyAI API key (sent raw, not `Bearer`). */
  apiKey: string;
  /** `"eu"` selects the EU data-residency endpoint. */
  region?: "us" | "eu" | undefined;
  /** Custom transcription instruction prepended to the model's prompt. */
  prompt?: string | undefined;
  /** Keyterms that bias the decoder (max 2048 chars total). */
  keyterms?: string[] | undefined;
  /** ISO 639-1 language code(s). Ignored when `prompt` is set. */
  languageCode?: string | string[] | undefined;
  /** Compute per-word start/end timestamps (extra latency). */
  timestamps?: boolean | undefined;
  /** Fetch implementation override (tests / proxied environments). */
  fetch?: typeof globalThis.fetch | undefined;
  signal?: AbortSignal | undefined;
};

/** Normalize the audio payload to bytes. An offset or SharedArrayBuffer-backed
 *  view needs no copy — the assembled body copies out of it by its own bounds. */
async function toAudioBytes(audio: SyncTranscribeOptions["audio"]): Promise<Uint8Array> {
  if (audio instanceof Uint8Array) return audio;
  if (audio instanceof ArrayBuffer) return new Uint8Array(audio);
  return new Uint8Array(await audio.arrayBuffer());
}

/** A boundary long and random enough that no payload can contain it. */
function randomBoundary(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `----aai-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Encode a `multipart/form-data` body: the binary `audio` part, then the
 * optional `config` part. Byte-for-byte what a spec-conformant `FormData`
 * encoder emits (see the module doc for why we do it ourselves).
 */
function encodeMultipart(
  boundary: string,
  audio: { bytes: Uint8Array; filename: string; contentType: string },
  config: string | undefined,
  // `Uint8Array<ArrayBuffer>`, not the default `ArrayBufferLike`: only a
  // non-shared buffer is a valid `BodyInit`.
): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="audio"; ` +
      `filename="${audio.filename}"\r\nContent-Type: ${audio.contentType}\r\n\r\n`,
  );
  const configPart =
    config === undefined
      ? ""
      : `--${boundary}\r\nContent-Disposition: form-data; name="config"\r\n\r\n${config}\r\n`;
  const tail = encoder.encode(`\r\n${configPart}--${boundary}--\r\n`);

  const body = new Uint8Array(head.length + audio.bytes.length + tail.length);
  body.set(head, 0);
  body.set(audio.bytes, head.length);
  body.set(tail, head.length + audio.bytes.length);
  return body;
}

function buildConfig(opts: SyncTranscribeOptions): Record<string, unknown> {
  return {
    ...(opts.sampleRate !== undefined && { sample_rate: opts.sampleRate }),
    ...(opts.channels !== undefined && { channels: opts.channels }),
    ...(opts.prompt !== undefined && { prompt: opts.prompt }),
    ...(opts.keyterms !== undefined && { keyterms_prompt: opts.keyterms }),
    ...(opts.languageCode !== undefined && { language_code: opts.languageCode }),
    ...(opts.timestamps !== undefined && { timestamps: opts.timestamps }),
  };
}

/**
 * Transcribe a short audio clip (80 ms – 120 s, ≤ 40 MB) in a single
 * synchronous request — no polling, no session management.
 *
 * @example
 * ```ts
 * import { syncTranscribe } from "@alexkroman1/aai/stt";
 *
 * const { text } = await syncTranscribe({
 *   audio: wavBytes,
 *   apiKey: ctx.env.ASSEMBLYAI_API_KEY ?? "",
 * });
 * ```
 *
 * @throws On a non-2xx response, with the API's error message (never the key).
 * @public
 */
export async function syncTranscribe(opts: SyncTranscribeOptions): Promise<SyncTranscript> {
  const contentType = opts.contentType ?? "audio/wav";
  if (contentType === "audio/pcm" && !(opts.sampleRate && opts.channels)) {
    throw new Error("syncTranscribe: audio/pcm requires sampleRate and channels");
  }
  const fetchFn = resolveFetch(opts.fetch);
  const url = opts.region === "eu" ? SYNC_TRANSCRIBE_EU_URL : SYNC_TRANSCRIBE_URL;

  const config = buildConfig(opts);
  const boundary = randomBoundary();
  const body = encodeMultipart(
    boundary,
    {
      bytes: await toAudioBytes(opts.audio),
      filename: contentType === "audio/wav" ? "audio.wav" : "audio.pcm",
      contentType,
    },
    Object.keys(config).length > 0 ? JSON.stringify(config) : undefined,
  );

  const resp = await fetchFn(url, {
    method: "POST",
    headers: {
      // The Sync API authenticates with the raw key, not `Bearer`.
      Authorization: opts.apiKey,
      "X-AAI-Model": SYNC_TRANSCRIBE_MODEL,
      // Set explicitly: nothing infers a boundary for a byte-array body.
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!resp.ok) {
    const detail = await httpErrorDetail(resp);
    throw new Error(
      `Sync transcription failed: HTTP ${resp.status}${detail ? ` (${detail})` : ""}`,
    );
  }
  return (await resp.json()) as SyncTranscript;
}
