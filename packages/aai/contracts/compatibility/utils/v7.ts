// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `utils` epoch 7.
 *
 * See `../agent/v1.ts` for what "frozen" obliges and why the imports are
 * relative. Epoch 7 adds how a step MAKES its request — `stepFetch`,
 * `multipartBody`, `StepTransportError` — to epoch 6's and takes nothing away,
 * so this file only demonstrates what is new.
 *
 * The subject is the shape that forced the primitive: a fan-out POSTing a large
 * body per item. `fetch` speaks HTTP/2 wherever the far side offers it, which
 * puts a whole batch on one connection — and a capacity limit then arrives as a
 * stream reset carrying no HTTP status for a retry policy to read. See
 * `sdk/step-fetch.ts`.
 */

import {
  isTransientStatus,
  type MultipartBody,
  type MultipartPart,
  multipartBody,
  type StepFetchInit,
  StepTransportError,
  stepFetch,
} from "../../../sdk/utils.ts";

/** What a step decides about one failed attempt. */
export type Attempt = { retry: boolean; because: string };

/**
 * Upload one chunk of audio and say what to do if it did not land.
 *
 * The two failures are DIFFERENT and that is this epoch's point: a response with
 * a status can be classified, and a connection that never answered cannot — so
 * `stepFetch` raises `StepTransportError` for the second, already naming the
 * cause chain a bare `TypeError: fetch failed` hides.
 */
export async function uploadChunk(key: string, bytes: Uint8Array, index: number): Promise<Attempt> {
  "use step";

  const part = multipartBody({
    name: "audio",
    filename: `chunk-${index}.wav`,
    type: "audio/wav",
    bytes,
  });

  try {
    const response = await stepFetch("https://sync.example.com/transcribe", {
      method: "POST",
      headers: { Authorization: key, ...part.headers },
      body: part.body,
      signal: AbortSignal.timeout(60_000),
    });
    if (response.ok) return { retry: false, because: "landed" };
    return { retry: isTransientStatus(response.status), because: `HTTP ${response.status}` };
  } catch (err: unknown) {
    // A connection failure is the transient case, and `codes` is what a caller
    // branches on when it wants to treat one reason differently from another.
    if (err instanceof StepTransportError) {
      return { retry: true, because: err.codes.join(",") || err.message };
    }
    throw err;
  }
}

/** The types are part of the surface too: a helper may name what it builds. */
export function textField(name: string, value: string): MultipartPart {
  return { name, bytes: new TextEncoder().encode(value) };
}

/** And what a caller may hold onto between building a body and sending it. */
export function withModel(body: MultipartBody, model: string): StepFetchInit {
  return { method: "POST", headers: { "X-AAI-Model": model, ...body.headers }, body: body.body };
}
