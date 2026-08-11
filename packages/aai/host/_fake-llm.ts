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
      const never: never = part;
      return never;
    }
  }
}

/** Wait `ms` or resolve immediately when `signal` aborts. */
function delayOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
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
      if (delayMs !== undefined && delayMs > 0) await delayOrAbort(delayMs, signal);
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
 * The returned value is cast to the `LanguageModel` union because we
 * implement the provider shape structurally rather than importing the
 * full `@ai-sdk/provider` types into the aai package.
 */
export function createFakeLanguageModel(
  options:
    | { script: ScriptedPart[]; delayMs?: number }
    | { steps: ScriptedPart[][]; delayMs?: number },
  // The OBJECT form of `LanguageModel`, not the union with a model-id string:
  // this builds a `specificationVersion: "v3"` model, and the wider type made
  // it unusable with `wrapLanguageModel` (which cannot wrap a string).
): Exclude<LanguageModel, string> & { readonly calls: readonly Record<string, unknown>[] } {
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
      // yielding an empty step so an unexpected extra call completes cleanly.
      const current = steps[stepIndex] ?? [];
      stepIndex++;
      const stream = new ReadableStream<StreamPart>({
        start(controller) {
          void streamScript(controller, current, delayMs, opts.abortSignal);
        },
      });
      return { stream };
    },
  };
  return model as unknown as Exclude<LanguageModel, string> & {
    readonly calls: readonly Record<string, unknown>[];
  };
}
