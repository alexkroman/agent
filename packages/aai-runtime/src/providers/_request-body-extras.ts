// Copyright 2026 the AAI authors. MIT license.
/**
 * Merges an `llm()` descriptor's `providerOptions` into the JSON body of every
 * request an OpenAI-compatible chat client sends, as a `fetch` wrapper.
 *
 * **Why the body and not the AI SDK's `providerOptions.openai`.** For
 * OpenRouter, Cerebras and any unregistered `baseUrl` provider, the options an
 * author writes are that VENDOR's wire fields — OpenRouter's
 * `provider: { order }`, a self-hosted server's `top_k`. `@ai-sdk/openai`'s
 * chat model parses `providerOptions.openai` with a plain `z.object`, which
 * strips every key it does not know, so routing them there dropped them
 * silently. The SDK has no typed channel for an arbitrary body field, so the
 * bytes are the only place one can be added.
 *
 * **Precedence: the SDK-built body WINS a collision.** The merge is a shallow
 * `{ ...extras, ...body }`, so a field the client wrote — `model`, `messages`,
 * `tools`, `stream`, and any call setting that was set (`temperature`,
 * `max_tokens`, …) — is never overwritten. An extra therefore acts as a
 * DEFAULT: `temperature` in `providerOptions` applies to a call that sets none.
 * That is the safe direction — an option that could replace `messages` or
 * `stream` would break the response parse rather than tune the request.
 *
 * Scope is narrow: only a string body that parses to a JSON object is
 * rewritten. Anything else — no body, a stream, a non-object — passes through
 * untouched, as does the response.
 */

import { isRecord, safeJsonParse } from "@alexkroman1/aai/utils";

/** Structural `fetch`, kept loose so it satisfies the AI SDK's option type. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * A `fetch` that merges `extras` into each JSON object request body beneath
 * the fields already there, then delegates to `inner` (default: the global
 * `fetch`, read at call time so a test's stub is honoured).
 */
export function mergeRequestBody(
  extras: Readonly<Record<string, unknown>>,
  inner?: FetchLike,
): FetchLike {
  return (input, init) => {
    // BASELINED against `guard-invariants` rule 29: the pooled fetch would be
    // WRONG here, not merely unnecessary. This sits UNDER a model provider's
    // client, whose own default is this same global, so a pooled default would
    // make a BODY option silently move the provider onto another transport
    // than it has without `providerOptions`. One call a turn, not a fan-out at
    // one origin; resolved per call so a spec can stub it.
    const send = inner ?? globalThis.fetch;
    const body = init?.body;
    if (typeof body !== "string") return send(input, init);
    const parsed = safeJsonParse(body);
    if (!isRecord(parsed)) return send(input, init);
    return send(input, { ...init, body: JSON.stringify({ ...extras, ...parsed }) });
  };
}
