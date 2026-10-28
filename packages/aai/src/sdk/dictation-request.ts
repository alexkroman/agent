// Copyright 2026 the AAI authors. MIT license.
/**
 * `handleDictationRequest()` — the server half of a microphone button, as one
 * web-standard `Request → Response`.
 *
 * `useDictation` in `@alexkroman1/aai-ui` records a clip and POSTs it (with
 * `dictationTranscriber`) to a route the page's own server owns; this IS that
 * route, so no server rewrites the parts every one of them needs and gets
 * wrong:
 *
 * - **The body is capped before it is buffered** — at
 *   {@link DICTATION_MAX_BYTES}, the longest clip the recorder makes — by
 *   `Content-Length` when sent and by counting the stream when not, so a
 *   client cannot make the server hold an arbitrary upload.
 * - **An empty body is refused** without a call to the service.
 * - **A refusal is readable**: the service's 429 stays a 429 with its
 *   `Retry-After`, so the page can say "try again"; a missing key is a 500
 *   (the SERVER is not configured); anything else the service refused is a 502
 *   naming it.
 *
 * Every answer is JSON: `{ text }` on success, `{ error }` otherwise — the
 * shape `dictationTranscriber` reads. It mounts anywhere a `Request` exists
 * (Hono's `c.req.raw`, a Next.js route handler, Deno, Workers). It is not an
 * `agent({ routes })` handler: those take JSON bodies of at most 64 KB, about a
 * second and a half of audio.
 *
 * **Authentication and metering are the caller's.** `apiKey` is the key of
 * whoever this request bills; deciding that, and how often they may ask, is
 * the server's own policy and comes before this call.
 *
 * @module dictation-request
 */

import { TranscribeError } from "./_transcribe-shared.ts";
import {
  DICTATION_MAX_BYTES,
  DICTATION_MAX_SECONDS,
  type TranscribeDictationOptions,
  transcribeDictation,
} from "./dictation.ts";

/**
 * The JSON body {@link handleDictationRequest} answers with.
 *
 * @sealed
 */
export type DictationResponseBody = { text: string } | { error: string };

/**
 * What {@link handleDictationRequest} accepts: the call's own options, minus
 * the two it reads off the request.
 *
 * @input
 */
export type DictationRequestOptions = Omit<TranscribeDictationOptions, "type" | "signal">;

/**
 * Answer one dictation request: the clip in the body, the text in the reply.
 *
 * @param request - A `POST` whose body is one recorded clip (a WAV, as
 *   `useDictation` records). Its `Content-Type` is forwarded; its `signal`
 *   cancels the upstream call when the client goes away.
 * @returns `200 { text }`, or `{ error }` with 405 (not a `POST`), 413 (over
 *   {@link DICTATION_MAX_BYTES}), 400 (no audio), 429 (the service's rate
 *   limit, `Retry-After` kept), 500 (no key) or 502 (any other refusal).
 * @throws Only what is not a dictation failure — a bug, not an answer.
 *
 * @example
 * ```ts
 * import { handleDictationRequest } from "@alexkroman1/aai/experimental";
 *
 * // Next.js app router: app/api/dictation/route.ts
 * export function POST(request: Request): Promise<Response> {
 *   return handleDictationRequest(request, { apiKey: process.env.ASSEMBLYAI_API_KEY ?? "" });
 * }
 * ```
 *
 * @public
 */
export async function handleDictationRequest(
  request: Request,
  options: DictationRequestOptions,
): Promise<Response> {
  if (request.method !== "POST") {
    return answer(405, { error: "Dictation takes a POST" }, { Allow: "POST" });
  }
  const audio = await readCapped(request, DICTATION_MAX_BYTES);
  if (audio === TOO_LARGE) {
    return answer(413, {
      error: `Recording too long — keep it under ${DICTATION_MAX_SECONDS} seconds`,
    });
  }
  if (audio.byteLength === 0) return answer(400, { error: "No audio in the request" });
  try {
    const { text } = await transcribeDictation(audio, {
      ...options,
      type: request.headers.get("content-type") || "audio/wav",
      signal: request.signal,
    });
    return answer(200, { text });
  } catch (err: unknown) {
    if (err instanceof TranscribeError) return refusal(err);
    throw err;
  }
}

const TOO_LARGE = Symbol("too-large");

/**
 * The body, or {@link TOO_LARGE} once it passes `max` — decided from
 * `Content-Length` when the client sent one, and by counting the stream when
 * it did not (a chunked upload declares nothing), cancelling the read there.
 */
async function readCapped(request: Request, max: number): Promise<Uint8Array | typeof TOO_LARGE> {
  const declared = Number(request.headers.get("content-length") ?? Number.NaN);
  if (declared > max) return TOO_LARGE;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return TOO_LARGE;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** A {@link TranscribeError} as the reply a page can act on. */
function refusal(err: TranscribeError): Response {
  if (err.status === 429) {
    const headers: Record<string, string> = {};
    if (err.retryAfter) {
      const wait = Math.ceil((err.retryAfter.getTime() - Date.now()) / 1000);
      headers["Retry-After"] = String(Math.max(1, wait));
    }
    return answer(429, { error: "Transcription is rate limited — try again shortly" }, headers);
  }
  // No status: refused before any request — the key is missing, which is
  // this server's configuration, not the upstream's answer.
  if (err.status === undefined) return answer(500, { error: err.message });
  return answer(502, { error: `Transcription failed: ${err.message}` });
}

function answer(
  status: number,
  body: DictationResponseBody,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, { status, headers });
}
