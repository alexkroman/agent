// Copyright 2026 the AAI authors. MIT license.
/**
 * Repairs non-conformant RESPONSES from the AssemblyAI LLM Gateway, as a `fetch`
 * wrapper. Two defects, each fatal to a turn:
 *
 * 1. `tool_calls` deltas that omit `id` and `type` (Claude; detailed below).
 * 2. A usage-only final chunk carrying `"choices": null` where the AI SDK's
 *    schema requires an array (Claude) — the turn dies with "Type validation
 *    failed" *after* the reply has streamed, so it reads as a random late
 *    failure.
 *
 * **Bytes are the only place these can be caught, which is why this is a `fetch`
 * wrapper and not middleware.** Both defects violate the wire schema the AI SDK
 * parses SSE frames with, so they kill the parse itself — there is no stream part
 * for a `wrapStream` to see, and no `params` a `transformParams` could touch. The
 * gateway's one REQUEST defect (Gemini rejecting `$schema`/`propertyNames`) does
 * have a typed representation, and lives in `_gateway-tool-schema.ts` as
 * `transformParams` middleware for exactly that reason; it used to be handled
 * here, at the cost of re-serializing the entire conversation on every request.
 *
 * **Why this exists.** The AssemblyAI LLM Gateway documents streamed
 * responses for OpenAI models only, but it will happily stream a Claude
 * model too — emitting `tool_calls` deltas that omit both `id` and `type`:
 *
 * ```text
 * data: {…"delta":{"tool_calls":[{"index":0,"function":{"name":"list_files","arguments":""}}]}…}
 * ```
 *
 * A conformant opening delta carries `id` and `type:"function"`. The AI SDK
 * tolerates the omission on the **non-streaming** path
 * (`toolCallId: toolCall.id ?? generateId()`), but
 * `StreamingToolCallTracker.processNewToolCall` in `@ai-sdk/provider-utils`
 * hard-throws `InvalidResponseDataError: Expected 'id' to be a string` —
 * even though it holds a `generateId` it falls back to later in
 * `finishToolCall`. So any gateway turn that calls a tool dies mid-stream.
 *
 * This wrapper sits under the provider and fills in what the gateway left
 * out: a synthetic id (stable per tool-call index for the life of one
 * response, so continuation deltas keep matching their opening delta) and
 * `type: "function"`. An id the upstream *does* send is never overwritten.
 *
 * Scope is deliberately narrow — only `text/event-stream` response bodies are
 * rewritten, and only the `id`/`type` fields of `tool_calls` entries plus an
 * explicitly-null `choices`. Everything else (text deltas, `[DONE]`, non-JSON
 * lines, error responses, status, headers) passes through byte-for-byte.
 * Remove each repair once the gateway emits conformant frames.
 */

import { isRecord, safeJsonParse } from "@alexkroman1/aai/utils";
import { getOrCreate } from "../_get-or-create.ts";

/** Structural `fetch`, kept loose so it satisfies the AI SDK's option type. */
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type StreamRepairOptions = {
  /**
   * Source of synthetic tool-call ids. Must be unique across the process —
   * ids outlive the response inside the conversation history. Injectable for
   * deterministic tests.
   */
  generateId?: () => string;
};

const DATA_PREFIX = "data:";
const SSE_CONTENT_TYPE = "text/event-stream";

/** Process-wide counter backing the default id source. */
let syntheticIdCounter = 0;

function defaultGenerateId(): string {
  syntheticIdCounter += 1;
  return `aai_tc_${syntheticIdCounter}`;
}

/** Loose record view of a wire object, for field-by-field probing. */
type Wire = Record<string, unknown>;

function asWire(value: unknown): Wire | null {
  return isRecord(value) ? value : null;
}

/**
 * Fill in one `tool_calls` entry's missing `id`/`type`. `position` is the
 * array slot, used only when the entry omits the required `index`, so calls
 * are not all mis-keyed to the same slot.
 */
function repairToolCall(
  entry: unknown,
  choiceKey: number,
  position: number,
  ids: Map<string, string>,
  newId: () => string,
): boolean {
  const call = asWire(entry);
  if (!call) return false;
  const callIndex = typeof call.index === "number" ? call.index : position;
  const key = `${choiceKey}:${callIndex}`;
  let changed = false;

  if (typeof call.id === "string" && call.id.length > 0) {
    // Upstream sent a real id — adopt it for this slot's continuations.
    ids.set(key, call.id);
  } else {
    // Minted ONCE per slot: a continuation delta for the same
    // `choice:index` must carry the id its first fragment was given, so the
    // factory may only run on a miss.
    call.id = getOrCreate(ids, key, newId);
    changed = true;
  }

  if (call.type !== "function") {
    call.type = "function";
    changed = true;
  }
  return changed;
}

/** Repair every `tool_calls` entry in one choice's delta. */
function repairChoice(
  choice: unknown,
  position: number,
  ids: Map<string, string>,
  newId: () => string,
): boolean {
  const wire = asWire(choice);
  const delta = asWire(wire?.delta);
  const toolCalls = delta?.tool_calls;
  if (!Array.isArray(toolCalls)) return false;
  const choiceKey = typeof wire?.index === "number" ? wire.index : position;
  let changed = false;
  for (const [callPosition, entry] of toolCalls.entries()) {
    changed = repairToolCall(entry, choiceKey, callPosition, ids, newId) || changed;
  }
  return changed;
}

/**
 * Normalize `"choices": null` to `[]`.
 *
 * Claude models on the gateway close a stream with a usage-only chunk whose
 * `choices` is an explicit `null`. The AI SDK's chunk schema requires an
 * array, so the union fails to parse and the turn dies with "Type validation
 * failed" — *after* the reply has already streamed, which makes it look like
 * a random late failure rather than a malformed final frame. An absent
 * `choices` key is left absent; only an explicit null is rewritten.
 */
function repairNullChoices(payload: unknown): boolean {
  const wire = asWire(payload);
  if (!(wire && "choices" in wire) || wire.choices !== null) return false;
  wire.choices = [];
  return true;
}

/**
 * Fill in missing `id`/`type` across a whole chunk, and normalize a null
 * `choices`. `ids` carries the per-response slot→id mapping. Returns true when
 * the payload was modified (so unmodified lines can be re-emitted verbatim).
 */
function repairChunk(payload: unknown, ids: Map<string, string>, newId: () => string): boolean {
  let changed = repairNullChoices(payload);
  const choices = asWire(payload)?.choices;
  if (!Array.isArray(choices)) return changed;
  for (const [position, choice] of choices.entries()) {
    changed = repairChoice(choice, position, ids, newId) || changed;
  }
  return changed;
}

/**
 * Whitespace-tolerant probe for the null-`choices` chunk.
 *
 * The compact `"choices":null` was justified by `JSON.stringify` never putting
 * whitespace after a colon — which is a claim about OUR serializer, and these
 * are the GATEWAY's bytes: any encoder that pretty-prints, or a proxy that
 * re-serializes, spells the same defect `"choices": null`. A miss is not a
 * degradation but the exact failure this module exists to prevent, the turn
 * dying on "Type validation failed" after the reply has already streamed.
 */
const NULL_CHOICES_RE = /"choices"\s*:\s*null/;

/**
 * Cheap pre-parse check: a line can only need repair when it carries a
 * `tool_calls` delta or an explicitly-null `choices`. Lines failing this check
 * — the vast majority of every stream (text deltas) — pass through with no
 * parse/stringify round trip, and byte-for-byte by construction. Being
 * permissive is free: a line that passes and turns out to need nothing is
 * re-emitted unchanged by {@link repairLine}.
 */
function mayNeedRepair(body: string): boolean {
  return body.includes('"tool_calls"') || NULL_CHOICES_RE.test(body);
}

/**
 * Repair one SSE line. Non-`data:` lines, the `[DONE]` sentinel, non-JSON
 * payloads, and chunks without tool calls are returned unchanged.
 */
function repairLine(line: string, ids: Map<string, string>, newId: () => string): string {
  if (!line.startsWith(DATA_PREFIX)) return line;
  const raw = line.slice(DATA_PREFIX.length);
  // Preserve CRLF framing: strip the \r before parsing, restore it after.
  const carriageReturn = raw.endsWith("\r");
  const body = (carriageReturn ? raw.slice(0, -1) : raw).trim();
  if (body === "" || body === "[DONE]") return line;
  if (!mayNeedRepair(body)) return line;

  const payload = safeJsonParse(body);
  if (payload === undefined || !repairChunk(payload, ids, newId)) return line;
  return `${DATA_PREFIX} ${JSON.stringify(payload)}${carriageReturn ? "\r" : ""}`;
}

/**
 * Line-buffering transform: SSE events arrive split across arbitrary network
 * chunk boundaries, so a chunk is only parseable once its whole line is in
 * hand.
 */
function createRepairTransform(newId: () => string): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const ids = new Map<string, string>();
  let buffer = "";

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      // Moving start index with one tail slice at the end: re-slicing the
      // buffer after every line reallocates the remaining tail per line,
      // which is O(chunk²) on a many-line network chunk.
      let start = 0;
      let out = "";
      let newline = buffer.indexOf("\n", start);
      while (newline !== -1) {
        const line = buffer.slice(start, newline);
        start = newline + 1;
        out += `${repairLine(line, ids, newId)}\n`;
        newline = buffer.indexOf("\n", start);
      }
      if (start > 0) buffer = buffer.slice(start);
      // ONE encode and ONE enqueue per network chunk, not per line. An OpenAI
      // frame is `data: {…}\n` plus a blank line, so a streamed reply was paying
      // two `TextEncoder.encode` calls and two full stream enqueues — queueing
      // plus backpressure machinery — per token, on the time-to-first-token path
      // of every voice turn, and the consumer re-joins the lines anyway. No
      // latency is traded away: `transform` is synchronous, so every line of a
      // chunk was already processed before control returned to the reader.
      if (out !== "") controller.enqueue(encoder.encode(out));
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer !== "") controller.enqueue(encoder.encode(repairLine(buffer, ids, newId)));
    },
  });
}

/**
 * Wrap a `fetch` so OpenAI-compatible SSE responses get their `tool_calls`
 * deltas repaired on the way through. Defaults to the ambient `fetch`,
 * resolved per call so tests can stub the global.
 */
export function repairOpenAiStream(
  baseFetch?: FetchLike,
  options: StreamRepairOptions = {},
): FetchLike {
  const newId = options.generateId ?? defaultGenerateId;
  return async (input, init) => {
    // Nothing on the request is touched here: the outgoing tool schemas are
    // pruned as typed `params` by `gatewayToolSchemaMiddleware`, before the
    // provider serializes anything (see `_gateway-tool-schema.ts`).
    // BASELINED against `guard-invariants` rule 29, which bans this fallback in
    // this package: the pooled `blobFetch` would be WRONG here, not merely
    // unnecessary. This wraps a caller-supplied PROVIDER fetch, resolves the
    // global per call so a spec can stub it, and the branch below builds a
    // `Headers` and a `Response` from the ambient realm — which undici 8
    // brand-checks against its own classes (`host/_undici.ts`). The origin is a
    // model provider, one streaming call a turn, not a fan-out at one origin.
    const response = await (baseFetch ?? globalThis.fetch)(input, init);
    const contentType = response.headers.get("content-type") ?? "";
    if (!(response.body && contentType.includes(SSE_CONTENT_TYPE))) return response;
    // The repair transform rewrites frames (synthetic tool-call ids lengthen
    // chunks), so the original body-length/encoding headers no longer describe
    // the stream. Copy the headers but drop those two, or a gateway/proxy that
    // set `content-length` would make undici truncate the repaired stream
    // mid-flight — on exactly the responses that needed repairing.
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(response.body.pipeThrough(createRepairTransform(newId)), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
