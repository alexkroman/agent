// Copyright 2026 the AAI authors. MIT license.
/**
 * `transcribeDictation()` — one spoken clip in, its text out, outside a workflow.
 *
 * AssemblyAI's dictation API is the synchronous endpoint {@link
 * stepTranscribeSync} already speaks: one `POST` carrying the whole clip,
 * answered with the words. This is the same request for a caller that is NOT a
 * workflow step — a server route turning a browser's "hold to talk" into text
 * for a text box — so it takes the key as a VALUE rather than naming an env var,
 * and uses whatever `fetch` it is handed rather than the step transport.
 * `stepTranscribeSync` is built on it, so the two cannot disagree about the
 * request.
 *
 * The browser half is `useDictation` in `@alexkroman1/aai-ui`: it records the
 * microphone at {@link DICTATION_SAMPLE_RATE}, stops by
 * {@link DICTATION_MAX_SECONDS}, and hands a WAV to a `transcribe` callback —
 * which on the far side of a server is this function, usually through
 * `handleDictationRequest` (`dictation-request.ts`), the whole route built on
 * it. **Never call this from a browser with an account key**: the key would
 * ship in the page.
 *
 * ```ts
 * import { transcribeDictation } from "@alexkroman1/aai/experimental";
 *
 * // A route handler: `apiKey` is the key of whoever this request bills.
 * export async function dictation(req: Request, apiKey: string): Promise<Response> {
 *   const audio = new Uint8Array(await req.arrayBuffer());
 *   const { text } = await transcribeDictation(audio, { apiKey });
 *   return Response.json({ text });
 * }
 * ```
 *
 * @module dictation
 */

import { transcribeFailure, transcribeRefusal, transcribeSignal } from "./_transcribe-shared.ts";
import { multipartBody } from "./step-fetch.ts";
import { WAV_HEADER_BYTES } from "./wav.ts";

/** The dictation (synchronous) endpoint. Global — it routes to the nearest region. */
export const DICTATION_ENDPOINT: string = "https://sync.assemblyai.com/transcribe";

/** Model sent when a caller names none; the endpoint routes on it. */
export const DICTATION_MODEL: string = "universal-3-5-pro";

/**
 * The rate a dictation clip is recorded at, in Hz.
 *
 * The endpoint's own default: it resamples anything else to this before the
 * model hears it, so recording higher only makes the upload larger.
 */
export const DICTATION_SAMPLE_RATE: number = 16_000;

/**
 * The longest clip the endpoint accepts, in seconds. Enforced by the service;
 * a recorder stops here rather than sending a clip that is refused whole.
 */
export const DICTATION_MAX_SECONDS: number = 120;

/**
 * The largest body a server route should accept for one clip: a mono 16-bit
 * WAV of {@link DICTATION_MAX_SECONDS} at {@link DICTATION_SAMPLE_RATE}, header
 * included. Far under the endpoint's 40 MB, so a route enforcing it refuses a
 * body no recorder in this SDK produces before reading it into memory.
 */
export const DICTATION_MAX_BYTES: number =
  WAV_HEADER_BYTES + DICTATION_SAMPLE_RATE * DICTATION_MAX_SECONDS * 2;

/**
 * The endpoint's deadline plus room to upload: the audio and the
 * transcription share one request.
 */
export const DICTATION_TIMEOUT_MS: number = 60_000;

/** The `fetch` shape {@link transcribeDictation} calls. The global `fetch` fits. */
export type DictationFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: Uint8Array<ArrayBuffer>;
    signal: AbortSignal;
  },
) => Promise<Response>;

/**
 * What {@link transcribeDictation} accepts.
 *
 * @input
 */
export type TranscribeDictationOptions = {
  /**
   * The AssemblyAI API key, sent raw (a `Bearer ` prefix is a 401 that reads
   * like a wrong key). A VALUE, unlike a step's `apiKeyEnv`: the caller is a
   * server that resolved whose key this request bills.
   */
  apiKey: string;
  /** Model to route to. Defaults to {@link DICTATION_MODEL}. */
  model?: string | undefined;
  /** Content type of the clip. Defaults to `"audio/wav"`. */
  type?: string | undefined;
  /** Filename declared in the multipart part. Defaults to `"audio.wav"`. */
  filename?: string | undefined;
  /** How the clip is named in a failure message. Defaults to `filename`. */
  label?: string | undefined;
  /** Deadline for the request. Defaults to {@link DICTATION_TIMEOUT_MS}. */
  timeoutMs?: number | undefined;
  /** Abort the request; combined with the deadline rather than replacing it. */
  signal?: AbortSignal | undefined;
  /** The transport. Defaults to the global `fetch`. */
  fetch?: DictationFetch | undefined;
};

/**
 * Transcribe one complete spoken clip.
 *
 * @param audio - A whole file, header included (a LIST is the same bytes in
 *   pieces — a `wavHeader` and the samples behind it). At most
 *   {@link DICTATION_MAX_SECONDS} long.
 * @returns The text, trimmed. EMPTY is a legitimate answer: the user pressed
 *   the button and said nothing.
 * @throws {TranscribeError} on a refusal (status, `retryable`, `retryAfter`
 *   carried), or — `retryable: false`, no request sent — on an empty key.
 *
 * @public
 */
export async function transcribeDictation(
  audio: Uint8Array | readonly Uint8Array[],
  options: TranscribeDictationOptions,
): Promise<{ text: string }> {
  if (!options.apiKey) throw transcribeRefusal("Dictation needs an AssemblyAI API key");
  const filename = options.filename ?? "audio.wav";
  const part = multipartBody({
    name: "audio",
    filename,
    type: options.type ?? "audio/wav",
    bytes: audio,
  });
  const send: DictationFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const response = await send(DICTATION_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: options.apiKey,
      "X-AAI-Model": options.model ?? DICTATION_MODEL,
      ...part.headers,
    },
    body: part.body as Uint8Array<ArrayBuffer>,
    signal: transcribeSignal({
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? DICTATION_TIMEOUT_MS,
    }),
  });
  if (!response.ok) throw await transcribeFailure(response, options.label ?? filename);

  const body = (await response.json()) as { text?: string };
  return { text: (body.text ?? "").trim() };
}
