// Copyright 2026 the AAI authors. MIT license.
/**
 * `POST /studio/dictation` — the composer's microphone: one recorded clip in,
 * its text out, so a prompt can be SPOKEN into the chat box.
 *
 * The browser records with aai-ui's `useDictation` and posts the WAV here;
 * this forwards it to AssemblyAI's dictation API with the SDK's
 * `transcribeDictation`, under the CALLER's own key — the same bearer the
 * request authenticated with, billed to the account that asked, exactly like a
 * studio chat turn (studio-llm.ts). The key never reaches the page, which is
 * why the browser does not call the endpoint itself.
 *
 * Not project-scoped: the text lands in a text box, and nothing is stored.
 * Bounded by `DICTATION_MAX_BYTES` (a full-length clip, the longest the
 * recorder makes) BEFORE the body is buffered, and metered by scope and
 * client IP (`DICTATION_RATE_LIMIT`) like every route that costs a third party.
 */

import {
  DICTATION_MAX_BYTES,
  DICTATION_MAX_SECONDS,
  transcribeDictation,
} from "@alexkroman1/aai/experimental";
import { TranscribeError } from "@alexkroman1/aai/step";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { StudioHonoEnv } from "./studio-context.ts";
import type { RefuseFn } from "./studio-route-limits.ts";

export type DictationRouteDeps = {
  /** The caller's workspace scope — what the per-scope window is keyed on. */
  requestScope: (c: Context<StudioHonoEnv>) => string;
  /** The `DICTATION_RATE_LIMIT` gate (scope + client IP), studio-route-limits.ts. */
  dictation: RefuseFn;
  /** Test seam: the dictation call, without a network. */
  transcribe?: typeof transcribeDictation | undefined;
};

/** Register `POST /dictation` on the studio router. The caller applies auth. */
export function registerDictationRoutes(
  studio: Hono<StudioHonoEnv>,
  deps: DictationRouteDeps,
): void {
  const transcribe = deps.transcribe ?? transcribeDictation;
  studio.post(
    "/dictation",
    bodyLimit({
      maxSize: DICTATION_MAX_BYTES,
      onError: (c) =>
        c.json(
          { error: `Recording too long — keep it under ${DICTATION_MAX_SECONDS} seconds` },
          413,
        ),
    }),
    async (c) => {
      const limited = await deps.dictation(deps.requestScope(c), c.req.raw);
      if (limited) return limited;
      const audio = new Uint8Array(await c.req.arrayBuffer());
      if (audio.byteLength === 0) return c.json({ error: "No audio in the request" }, 400);
      try {
        const { text } = await transcribe(audio, {
          apiKey: c.var.apiKey,
          type: c.req.header("Content-Type") || "audio/wav",
          signal: c.req.raw.signal,
        });
        return c.json({ text });
      } catch (err: unknown) {
        if (!(err instanceof TranscribeError)) throw err;
        return refusal(c, err);
      }
    },
  );
}

/**
 * The service's refusal, passed through readably: a rate limit keeps its
 * status (and wait) so the client can say "try again", anything else is the
 * upstream failing this request.
 */
function refusal(c: Context<StudioHonoEnv>, err: TranscribeError): Response {
  if (err.status !== 429) return c.json({ error: `Transcription failed: ${err.message}` }, 502);
  if (err.retryAfter) {
    const wait = Math.ceil((err.retryAfter.getTime() - Date.now()) / 1000);
    c.header("Retry-After", String(Math.max(1, wait)));
  }
  return c.json({ error: "Transcription is rate limited — try again shortly" }, 429);
}
