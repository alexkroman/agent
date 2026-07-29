// Copyright 2026 the AAI authors. MIT license.
/**
 * AssemblyAI Sync API client — synchronous transcription of short audio.
 *
 * One HTTP request, transcript back in the response: the preferred path for
 * short (under two minutes) audio files, versus opening a realtime streaming
 * session and replaying the file through it. Zero dependencies (plain
 * `fetch` + `FormData`), so it runs on the host, in Deno, and in the guest
 * sandbox alike.
 *
 * API reference: https://assemblyai.com/docs/api-reference/sync-api/transcribe
 */

/** US (default) Sync API endpoint. */
export const SYNC_TRANSCRIBE_URL = "https://sync.assemblyai.com/transcribe";

/** EU data-residency Sync API endpoint. */
export const SYNC_TRANSCRIBE_EU_URL = "https://sync.eu.assemblyai.com/transcribe";

/** Model identifier the Sync API routes on. */
export const SYNC_TRANSCRIBE_MODEL = "universal-3-5-pro";

/** The Sync API accepts at most this much audio; longer files need the
 *  pre-recorded (async) API or a realtime streaming session. */
export const MAX_SYNC_AUDIO_SECONDS = 120;

/** Hostname the Sync API lives on (both regional endpoints are subdomains). */
export const SYNC_TRANSCRIBE_HOST = "sync.assemblyai.com";

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

/** Normalize the audio payload into a Blob with the right content type. */
function toAudioBlob(audio: SyncTranscribeOptions["audio"], contentType: string): Blob {
  if (audio instanceof Blob) return audio;
  // Copy into a fresh ArrayBuffer-backed view so a SharedArrayBuffer or
  // offset view can't leak extra bytes into the multipart body.
  const bytes = audio instanceof Uint8Array ? Uint8Array.from(audio) : new Uint8Array(audio);
  return new Blob([bytes.buffer], { type: contentType });
}

/** Best-effort error detail from a failed response's JSON body. */
async function errorDetail(resp: Response): Promise<string> {
  return await resp
    .json()
    .then((e: unknown) => {
      const err = e as { message?: string; detail?: string } | null;
      return err?.message ?? err?.detail ?? "";
    })
    .catch(() => "");
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
  const fetchFn = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const url = opts.region === "eu" ? SYNC_TRANSCRIBE_EU_URL : SYNC_TRANSCRIBE_URL;

  const form = new FormData();
  form.append(
    "audio",
    toAudioBlob(opts.audio, contentType),
    contentType === "audio/wav" ? "audio.wav" : "audio.pcm",
  );
  const config = buildConfig(opts);
  if (Object.keys(config).length > 0) form.append("config", JSON.stringify(config));

  const resp = await fetchFn(url, {
    method: "POST",
    // The Sync API authenticates with the raw key, not `Bearer`.
    headers: { Authorization: opts.apiKey, "X-AAI-Model": SYNC_TRANSCRIBE_MODEL },
    body: form,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!resp.ok) {
    const detail = await errorDetail(resp);
    throw new Error(
      `Sync transcription failed: HTTP ${resp.status}${detail ? ` (${detail})` : ""}`,
    );
  }
  return (await resp.json()) as SyncTranscript;
}
