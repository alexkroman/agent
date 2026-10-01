// Copyright 2026 the AAI authors. MIT license.
/**
 * The host half of `fallback([...])` for the LLM stage: a `LanguageModel` that
 * tries its members in order, per REQUEST.
 *
 * ## When a member is abandoned
 *
 * - **`doGenerate` / `doStream` throws** — a network failure, any HTTP error
 *   status (auth, a bad model id, 429, 5xx): the next member gets the same
 *   call options.
 * - **The stream errors before its first CONTENT part** — an `error` part, or
 *   the stream rejecting, while only `stream-start` / `response-metadata` /
 *   `raw` have arrived. Those prefix parts are buffered and discarded with the
 *   member, so the consumer sees one coherent stream from one vendor.
 *
 * Never on an abort (the call's `abortSignal`), and never once text, reasoning
 * or a tool call has streamed: from then on an error belongs to the turn, as
 * it would without a fallback. When every member fails, the LAST one's error
 * is thrown (or streamed) unchanged. The next request starts from the primary
 * again — a fallback is a per-request decision, not a circuit breaker.
 *
 * The AI SDK's own `maxRetries` wraps THIS model, so a retryable failure of
 * the last member retries the whole list.
 *
 * ## Reporting
 *
 * The model is resolved once per runtime and shared by every session, so it
 * holds no listener. {@link withFailoverListener} returns a per-session copy
 * bound to that session's listener; the pipeline transport makes one.
 */

import type { LanguageModel } from "ai";
import { type FailoverListener, failoverOf } from "./_failover.ts";
import type { DeferredModel } from "./_lazy-model.ts";

type Member = { readonly model: DeferredModel; readonly kind: string };
type StreamResult = Awaited<ReturnType<DeferredModel["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

/** Parts that may arrive before any content, and are discarded with a failed member. */
const PREFIX_PARTS: ReadonlySet<string> = new Set(["stream-start", "response-metadata", "raw"]);

/** The members behind each fallback model this module built — how a copy is re-bound. */
const MEMBERS = new WeakMap<object, readonly Member[]>();

/** A thrown error, or the `error` part a stream reported, as one value. */
class StreamFailure {
  readonly cause: unknown;
  constructor(cause: unknown) {
    this.cause = cause;
  }
}

function v4(model: LanguageModel, kind: string): DeferredModel {
  if (typeof model === "string" || model.specificationVersion !== "v4") {
    throw new TypeError(
      `LLM fallback: the "${kind}" member did not resolve to a v4 language model object.`,
    );
  }
  return model;
}

/** Build a fallback model over resolved members, in order. */
export function fallbackLanguageModel(
  members: readonly { model: LanguageModel; kind: string }[],
): LanguageModel {
  return build(
    members.map((m) => ({ model: v4(m.model, m.kind), kind: m.kind })),
    () => undefined,
  );
}

/**
 * `model` bound to one session's failover listener. Any model that is not a
 * fallback is returned as-is (by identity), so a call site needs no branch.
 */
export function withFailoverListener(
  model: LanguageModel,
  onFailover: FailoverListener,
): LanguageModel {
  const members = typeof model === "string" ? undefined : MEMBERS.get(model);
  return members === undefined ? model : build(members, onFailover);
}

function build(members: readonly Member[], onFailover: FailoverListener): DeferredModel {
  const primary = members[0];
  if (primary === undefined || members.length < 2) {
    throw new Error("LLM fallback needs at least two providers to fail over between.");
  }
  /** Report the switch past member `i`, or say there is none to switch to. */
  const advance = (i: number, cause: unknown, aborted: boolean): boolean => {
    const next = members[i + 1];
    if (aborted || next === undefined) return false;
    onFailover(failoverOf("llm", members[i]?.kind ?? "", next.kind, cause));
    return true;
  };

  const model: DeferredModel = {
    specificationVersion: "v4",
    // The primary's identity: the context budget and the settings log read
    // these, and the primary is what a healthy session runs on.
    provider: primary.model.provider,
    modelId: primary.model.modelId,
    get supportedUrls() {
      return primary.model.supportedUrls;
    },
    async doGenerate(options) {
      for (let i = 0; ; i++) {
        const member = members[i];
        if (member === undefined) throw new Error("LLM fallback: no member left to try.");
        try {
          return await member.model.doGenerate(options);
        } catch (err) {
          if (!advance(i, err, options.abortSignal?.aborted === true)) throw err;
        }
      }
    },
    async doStream(options) {
      const aborted = (): boolean => options.abortSignal?.aborted === true;
      for (let i = 0; ; i++) {
        const member = members[i];
        if (member === undefined) throw new Error("LLM fallback: no member left to try.");
        const attempt = await streamFrom(member, options);
        if (attempt.ok) return attempt.result;
        // Throw (open failure) or forward (stream failure) when there is no
        // next member or the call was aborted — the lone provider's behaviour.
        if (!advance(i, attempt.cause, aborted())) {
          if (attempt.result === undefined) throw attempt.cause;
          return attempt.result;
        }
        await attempt.result?.stream.cancel().catch(() => undefined);
      }
    },
  };
  MEMBERS.set(model, members);
  return model;
}

/**
 * One member's stream, peeked to its first content part. `ok: false` carries
 * the failure, and — for a stream that FAILED rather than a call that threw —
 * the result to forward if no member is left to try.
 */
async function streamFrom(
  member: Member,
  options: Parameters<DeferredModel["doStream"]>[0],
): Promise<
  { ok: true; result: StreamResult } | { ok: false; cause: unknown; result?: StreamResult }
> {
  let result: StreamResult;
  try {
    result = await member.model.doStream(options);
  } catch (cause) {
    return { ok: false, cause };
  }
  const reader = result.stream.getReader();
  const prefix: StreamPart[] = [];
  const outcome = await peek(reader, prefix);
  const forwarded = { ...result, stream: resume(reader, prefix, outcome) };
  return outcome instanceof StreamFailure
    ? { ok: false, cause: outcome.cause, result: forwarded }
    : { ok: true, result: forwarded };
}

/**
 * Read up to the first content part, buffering the prefix. Answers the part
 * that ended the peek (buffered too), `"done"` for a stream with no content,
 * or a {@link StreamFailure}.
 */
async function peek(
  reader: ReadableStreamDefaultReader<StreamPart>,
  prefix: StreamPart[],
): Promise<"content" | "done" | StreamFailure> {
  for (;;) {
    let read: Awaited<ReturnType<typeof reader.read>>;
    try {
      read = await reader.read();
    } catch (err) {
      return new StreamFailure(err);
    }
    if (read.done) return "done";
    const part = read.value;
    if (part.type === "error") {
      prefix.push(part);
      return new StreamFailure(part.error);
    }
    prefix.push(part);
    if (!PREFIX_PARTS.has(part.type)) return "content";
  }
}

/** The stream a consumer reads: the buffered prefix, then the rest of `reader`. */
function resume(
  reader: ReadableStreamDefaultReader<StreamPart>,
  prefix: readonly StreamPart[],
  outcome: "content" | "done" | StreamFailure,
): ReadableStream<StreamPart> {
  return new ReadableStream<StreamPart>({
    start(controller) {
      for (const part of prefix) controller.enqueue(part);
      if (outcome === "done") controller.close();
      else if (outcome instanceof StreamFailure && prefix.at(-1)?.type !== "error") {
        // The LAST member's stream rejected (no `error` part to forward): the
        // consumer sees the rejection, as it would have from that member alone.
        controller.error(outcome.cause);
      }
    },
    async pull(controller) {
      try {
        const read = await reader.read();
        if (read.done) controller.close();
        else controller.enqueue(read.value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
