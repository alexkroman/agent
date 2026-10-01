// Copyright 2026 the AAI authors. MIT license.
/**
 * The one call path for a builtin backed by a keyed third-party JSON API
 * (`brave_search`, `google_places`): read the key from the AGENT env, refuse
 * without it, send it, and turn the failures a key can cause into a sentence
 * the model can relay.
 *
 * **The key comes from `ctx.env` on every call, never the host's
 * `process.env`** — the platform owns no provider credential, and a builtin is
 * no exception. The deploy preflight checks the key without the author listing
 * it in `requiredEnv` (`BUILTIN_TOOL_ENV`, `sdk/derived-env.ts` — the same rule
 * an MCP server's `tokenEnv` follows); that check only WARNS, so an unset key
 * is still answered at call time with {@link missingEnvMessage}, the sentence
 * `requireEnv` throws.
 */

import { missingEnvMessage } from "../sdk/_missing-env.ts";
import { MAX_JSON_BYTES } from "../sdk/constants.ts";
import type { ToolContext } from "../sdk/tool-context.ts";
import { fetchCappedJson } from "./_fetch-capped.ts";

/** One keyed API call. @internal */
export type KeyedApiRequest = {
  /** The service's name as the model should say it: "Brave Search". */
  service: string;
  /** The agent-env variable holding the key. */
  keyEnv: string;
  /** How to fix a rejected key, after "check the key is valid and …". */
  keyHint: string;
  /**
   * Statuses that mean the KEY was refused. 401/403 everywhere; a service
   * that answers a bad key with something else (Google: 400) adds it.
   */
  rejectedStatuses?: readonly number[];
  url: string;
  /** Request headers, given the key — each service sends it differently. */
  headers: (key: string) => Record<string, string>;
  /** A JSON body, which makes the request a POST. */
  body?: string;
  fetch: typeof globalThis.fetch;
};

/** @internal */
export type KeyedApiResult = { ok: true; value: unknown } | { ok: false; error: string };

const KEY_REJECTED = [401, 403];

/**
 * Call a keyed JSON API on the agent's behalf. Never throws — every failure is
 * `{ ok: false, error }`, ready to hand the model as the tool's `error`.
 *
 * @internal
 */
export async function fetchKeyedJson(
  ctx: Pick<ToolContext, "env">,
  req: KeyedApiRequest,
): Promise<KeyedApiResult> {
  const key = ctx.env[req.keyEnv]?.trim();
  if (!key) return { ok: false, error: missingEnvMessage(req.keyEnv) };
  const res = await fetchCappedJson(req.url, {
    fetch: req.fetch,
    accept: "application/json",
    headers: req.headers(key),
    body: req.body,
    maxBytes: MAX_JSON_BYTES,
  });
  if (res.ok) return res;
  const rejected = [...KEY_REJECTED, ...(req.rejectedStatuses ?? [])];
  if (res.status !== undefined && rejected.includes(res.status)) {
    return {
      ok: false,
      error: `${req.service} rejected ${req.keyEnv} (${res.error}) — check the key is valid and ${req.keyHint}`,
    };
  }
  if (res.status === 429) {
    return {
      ok: false,
      error: `${req.service} rate limit reached (${res.error}) — try again shortly`,
    };
  }
  return { ok: false, error: `${req.service} request failed: ${res.error}` };
}
