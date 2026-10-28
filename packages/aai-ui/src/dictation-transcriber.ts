// Copyright 2026 the AAI authors. MIT license.
/**
 * `dictationTranscriber(url)` — the `transcribe` callback `useDictation` needs,
 * for a server answering the SDK's `handleDictationRequest`.
 *
 * Every page that dictates writes the same few lines: POST the clip, read
 * `{ text }`, and turn a refusal into an error whose message is the SERVER's
 * sentence ("Recording too long — keep it under 120 seconds", "Transcription
 * is rate limited — try again shortly") rather than a bare status. This is
 * those lines, against the one reply shape the SDK route answers with.
 */

import { isRecord } from "@alexkroman1/aai/utils";

/**
 * Options for {@link dictationTranscriber}.
 *
 * @input
 */
export type DictationTranscriberOptions = {
  /**
   * Headers sent with each clip — an `authorization` for a route behind a
   * bearer. A FUNCTION is read per request, so a token that rotates is never
   * sent stale.
   */
  headers?: Record<string, string> | (() => Record<string, string>);
  /** The transport. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
};

/**
 * A `transcribe` for `useDictation` that POSTs each clip to `url` and
 * reads the `{ text } | { error }` reply `handleDictationRequest` answers with.
 *
 * Rejects with the server's own `error` sentence on a refusal, and with a
 * status-naming message when the reply is not that shape (a proxy's HTML error
 * page) — `useDictation` shows either as its `error`.
 *
 * @param url - The route, resolved like any `fetch` URL (relative to the page).
 *
 * @example
 * ```ts
 * import { dictationTranscriber } from "@alexkroman1/aai-ui";
 *
 * export const transcribe = dictationTranscriber("/api/dictation", {
 *   headers: () => ({ authorization: `Bearer ${localStorage.getItem("token") ?? ""}` }),
 * });
 * ```
 *
 * @public
 */
export function dictationTranscriber(
  url: string,
  options: DictationTranscriberOptions = {},
  // Spelled out rather than `UseDictationOptions["transcribe"]`: that is an
  // `@input` type, and naming it in a RESULT would make it reached both ways.
): (audio: Blob, options: { signal: AbortSignal }) => Promise<string> {
  return async (audio, { signal }) => {
    const send = options.fetch ?? fetch;
    const extra = typeof options.headers === "function" ? options.headers() : options.headers;
    const res = await send(url, {
      method: "POST",
      body: audio,
      headers: { "Content-Type": audio.type || "audio/wav", ...extra },
      signal,
    });
    const body: unknown = await res.json().catch(() => undefined);
    if (res.ok && isRecord(body) && typeof body.text === "string") return body.text;
    if (isRecord(body) && typeof body.error === "string") throw new Error(body.error);
    throw new Error(`Dictation failed (HTTP ${res.status})`);
  };
}
