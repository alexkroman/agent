// Copyright 2026 the AAI authors. MIT license.
/**
 * `POST /studio/dictation` — the composer's microphone: one recorded clip in,
 * its text out, so a prompt can be SPOKEN into the chat box.
 *
 * The browser records with aai-ui's `useDictation` and posts the WAV here.
 * Everything about the request itself — the body cap before it is buffered,
 * the empty-body refusal, the call to AssemblyAI's dictation API, the
 * `{ text } | { error }` reply and its 413/429/502 mapping — is the SDK's
 * `handleDictationRequest`, the same handler any server mounts. What is the
 * studio's is WHO pays and HOW OFTEN: the CALLER's own key — the bearer the
 * request authenticated with, billed to the account that asked, exactly like a
 * studio chat turn (studio-llm.ts) — and a per-scope and per-IP window
 * (`DICTATION_RATE_LIMIT`) like every route that costs a third party.
 *
 * Not project-scoped: the text lands in a text box, and nothing is stored.
 */

import { type DictationFetch, handleDictationRequest } from "@alexkroman1/aai/experimental";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { Context, Hono } from "hono";
import type { StudioHonoEnv } from "./studio-context.ts";
import type { RefuseFn } from "./studio-route-limits.ts";

export type DictationRouteDeps = {
  /** The caller's workspace scope — what the per-scope window is keyed on. */
  requestScope: (c: Context<StudioHonoEnv>) => string;
  /** The `DICTATION_RATE_LIMIT` gate (scope + client IP), studio-route-limits.ts. */
  dictation: RefuseFn;
  /** Test seam: the transport to the dictation API, without a network. */
  dictationFetch?: DictationFetch | undefined;
};

/** Register `POST /dictation` on the studio router. The caller applies auth. */
export function registerDictationRoutes(
  studio: Hono<StudioHonoEnv>,
  deps: DictationRouteDeps,
): void {
  studio.post("/dictation", async (c) => {
    const limited = await deps.dictation(deps.requestScope(c), c.req.raw);
    if (limited) return limited;
    return handleDictationRequest(c.req.raw, {
      apiKey: c.var.apiKey,
      ...omitUndefined({ fetch: deps.dictationFetch }),
    });
  });
}
