// Copyright 2025 the AAI authors. MIT license.
/**
 * The scripted fake `LanguageModel` for pipeline-session tests.
 *
 * Split from `_pipeline-test-fakes.ts` (the STT/TTS provider fakes) purely for
 * file length; both are re-exported from there, which stays the one import
 * path for specs.
 *
 * @internal Not part of the public API.
 */

import { sleep } from "@alexkroman1/aai/host-internal";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { LanguageModel } from "ai";

// ─── Fake LLM ───────────────────────────────────────────────────────────────

/**
 * A scripted stream part. `text` yields a `text-delta` in the LLM provider's
 * raw wire format; `tool-call` / `tool-result` emit the corresponding parts
 * (v3 provider spec: `toolCallId`, `toolName`, `input` as JSON string for
 * calls, `result` as JSON-serialisable value for results).
 */
export type ScriptedPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
  | { type: "tool-result"; toolCallId: string; toolName: string; result: unknown }
  | { type: "error"; error: unknown };

/**
 * Shape of the single stream part yielded by an LLM provider's `doStream()`.
 * This is a loose local definition — the real type lives in `@ai-sdk/provider`
 * as `LanguageModelV3StreamPart`, but we don't want a direct dependency on
 * that package. The test fakes only need enough of the shape that the
 * `ai` package's `streamText` will forward through to consumers.
 */
type StreamPart =
  | { type: "stream-start"; warnings: never[] }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
  | { type: "tool-result"; toolCallId: string; toolName: string; result: NonNullable<unknown> }
  | { type: "error"; error: unknown }
  | {
      type: "finish";
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
      finishReason: string;
    };

function scriptedPartToStreamPart(part: ScriptedPart, textId: string): StreamPart {
  switch (part.type) {
    case "text":
      return { type: "text-delta", id: textId, delta: part.text };
    case "tool-call":
      return {
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      };
    case "tool-result":
      return {
        type: "tool-result",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        result: part.result as NonNullable<unknown>,
      };
    case "error":
      return { type: "error", error: part.error };
    default: {
      // A fake that fabricates a frame the real provider cannot emit is a
      // FIDELITY bug, and returning the `never` handed it an `undefined` frame
      // to enqueue — the fake's own contract broken, silently, from a branch
      // typed as returning a StreamPart.
      const unreachable: never = part;
      throw new Error(`fake LLM: unsupported scripted part ${JSON.stringify(unreachable)}`);
    }
  }
}

async function streamScript(
  controller: ReadableStreamDefaultController<StreamPart>,
  script: ScriptedPart[],
  delayMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const textId = "text-1";
  controller.enqueue({ type: "stream-start", warnings: [] });
  controller.enqueue({ type: "text-start", id: textId });
  try {
    for (const part of script) {
      if (signal?.aborted) break;
      if (delayMs !== undefined && delayMs > 0) await sleep(delayMs, omitUndefined({ signal }));
      if (signal?.aborted) break;
      controller.enqueue(scriptedPartToStreamPart(part, textId));
    }
  } finally {
    controller.enqueue({ type: "text-end", id: textId });
    // A step that emits a tool call finishes with reason "tool-calls" (real
    // providers do this); the SDK relies on it to accumulate the assistant
    // tool-call message and its result into `response.messages` for the next
    // step/turn. Reporting "stop" here silently drops tool context.
    let finishReason = "stop";
    if (signal?.aborted) finishReason = "other";
    else if (script.some((p) => p.type === "tool-call")) finishReason = "tool-calls";
    controller.enqueue({
      type: "finish",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      finishReason,
    });
    controller.close();
  }
}

/** A fake model plus the record of what it was asked. */
export type FakeLanguageModel = LanguageModel & {
  readonly calls: readonly Record<string, unknown>[];
};

/**
 * The ONE narrowing in this file, and every fake here goes through it.
 *
 * A fake implements the provider shape STRUCTURALLY — importing the full
 * `@ai-sdk/provider` types into this package to type it nominally is a
 * dependency nothing else needs — so a cast is unavoidable. What is avoidable
 * is a second one: the escape-hatch ratchet counts occurrences, and a
 * concentration of identical casts is a missing typed seam. This is the seam.
 */
function asFakeLanguageModel(model: object): FakeLanguageModel {
  return model as unknown as FakeLanguageModel;
}

/**
 * One scripted `doGenerate` reply: a final answer, or a tool call the loop is
 * expected to run and come back from.
 */
export type ScriptedTurn =
  | { text: string }
  | { call: { name: string; input: Record<string, unknown>; id?: string } };

/**
 * A fake model that answers a SCRIPT one entry per `doGenerate` — what a
 * non-streaming TOOL LOOP needs, and what the single-reply fakes in
 * `generate.test.ts` cannot be.
 *
 * Past the end of the script it ANSWERS rather than throwing: a loop that took
 * one step more than a spec expected should fail on the assertion that names
 * the difference, not on a fake running dry.
 */
export function createScriptedOneShotModel(script: readonly ScriptedTurn[]): FakeLanguageModel {
  const calls: Record<string, unknown>[] = [];
  let index = 0;
  return asFakeLanguageModel({
    specificationVersion: "v3" as const,
    provider: "fake-llm",
    modelId: "fake-llm-1",
    supportedUrls: {} as Record<string, RegExp[]>,
    calls,
    async doGenerate(opts: Record<string, unknown>) {
      calls.push(opts);
      const turn = script[index++] ?? { text: "(script exhausted)" };
      return {
        content:
          "text" in turn
            ? [{ type: "text", text: turn.text }]
            : [
                {
                  type: "tool-call",
                  toolCallId: turn.call.id ?? `call-${index}`,
                  toolName: turn.call.name,
                  input: JSON.stringify(turn.call.input),
                },
              ],
        // The `{ unified, raw }` PAIR the current provider spec reads, not a
        // bare string — `generateText` parses structured output only when the
        // last step finished with `stop`, so the old shape resolves `undefined`
        // and throws `NoOutputGeneratedError` naming an empty model reply.
        finishReason: {
          unified: "text" in turn ? ("stop" as const) : ("tool-calls" as const),
          raw: undefined,
        },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
    async doStream(): Promise<never> {
      throw new Error("scripted one-shot LLM: doStream not implemented");
    },
  });
}

/**
 * Create a fake `LanguageModel` that yields a scripted sequence of
 * parts when `streamText` drives `doStream()`. The fake ignores the prompt
 * and tools — it simply replays the script.
 *
 * Pass `{ delayMs: N }` to space out parts with `setTimeout(N)` so that
 * barge-in tests can abort mid-stream deterministically.
 *
 * Pass `{ steps: ScriptedPart[][] }` (instead of `script`) for multi-step
 * scenarios: each call to `doStream()` consumes the next step's parts.
 * This is how `streamText` drives multi-turn tool loops under `stopWhen`.
 *
 * Pass `{ repeatLast: true }` to answer every call past the last scripted step
 * with that step again, instead of with nothing.
 */
export function createFakeLanguageModel(
  options:
    | { script: ScriptedPart[]; delayMs?: number; repeatLast?: boolean }
    | { steps: ScriptedPart[][]; delayMs?: number; repeatLast?: boolean },
): FakeLanguageModel {
  const delayMs = options.delayMs;
  const steps: ScriptedPart[][] = "steps" in options ? options.steps : [options.script];
  let stepIndex = 0;
  const calls: Record<string, unknown>[] = [];
  const model = {
    specificationVersion: "v3" as const,
    provider: "fake-llm",
    modelId: "fake-llm-1",
    supportedUrls: {} as Record<string, RegExp[]>,
    calls,
    async doGenerate(): Promise<never> {
      throw new Error("fake LLM: doGenerate not implemented");
    },
    async doStream(opts: Record<string, unknown> & { abortSignal?: AbortSignal }): Promise<{
      stream: ReadableStream<StreamPart>;
    }> {
      calls.push(opts);
      // Advance one step per call; after the last scripted step, keep
      // yielding an empty step so an unexpected extra call completes cleanly —
      // or, with `repeatLast`, keep answering with the last one. That option is
      // for a caller who cannot know how many calls a turn will make (the eval
      // stub provider: one scripted reply has to serve however many steps the
      // pipeline takes), where an empty tail reads as an agent that went silent.
      const current = steps[stepIndex] ?? (options.repeatLast ? (steps.at(-1) ?? []) : []);
      stepIndex++;
      const stream = new ReadableStream<StreamPart>({
        start(controller) {
          void streamScript(controller, current, delayMs, opts.abortSignal);
        },
      });
      return { stream };
    },
  };
  return asFakeLanguageModel(model);
}
