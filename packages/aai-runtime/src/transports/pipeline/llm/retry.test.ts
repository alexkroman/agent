// Copyright 2026 the AAI authors. MIT license.
// A failed provider call (429, 5xx) and how long a turn waits on its retries.
//
// The measured case (tau2-bench voice, eight sessions on one Cerebras key):
// the AI SDK obeyed a 429's `retry-after`, so a turn's first token came ~60 s
// after its request while the caller sat through dead-air filler. See
// `./retry.ts`.

import { APICallError, type LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import { silentLogger } from "../../../_logger-test-utils.ts";
import { fallbackLanguageModel } from "../../../providers/_fallback-llm.ts";
import { useVirtualTime } from "../../_pipeline-transport-harness.ts";
import {
  LLM_RETRY_BUDGET_MS,
  LLM_RETRY_INITIAL_DELAY_MS,
  requestedRetryDelayMs,
  withBoundedRetries,
} from "./retry.ts";
import { consumeLlmStream } from "./stream.ts";

useVirtualTime();

type Mock = InstanceType<typeof MockLanguageModelV4>;
type StreamPart =
  Awaited<ReturnType<Mock["doStream"]>>["stream"] extends ReadableStream<infer P> ? P : never;
type ConsumeArgs = Parameters<typeof consumeLlmStream>[0];

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function textStream(text: string): ReadableStream<StreamPart> {
  const parts: StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", usage: USAGE, finishReason: { unified: "stop", raw: "stop" } },
  ];
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

/** What a provider's rate limiter answers. */
function rateLimited(headers: Record<string, string> = {}, status = 429): APICallError {
  return new APICallError({
    message: "Too Many Requests: token_quota_exceeded",
    url: "https://api.cerebras.ai/v1/chat/completions",
    requestBodyValues: {},
    statusCode: status,
    responseHeaders: headers,
    isRetryable: true,
  });
}

/**
 * A model whose first `failures` calls throw `error`, and which answers `text`
 * after that. Records WHEN each call was made, in virtual ms.
 */
function failingThen(
  failures: number,
  error: Error,
  text = "Your order shipped.",
  provider = "primary",
): { model: Mock; callTimes: number[] } {
  const callTimes: number[] = [];
  const model = new MockLanguageModelV4({
    provider,
    modelId: `${provider}-model`,
    doStream: async () => {
      callTimes.push(Date.now());
      if (callTimes.length <= failures) throw error;
      return { stream: textStream(text) };
    },
  });
  return { model, callTimes };
}

function consume(
  overrides: Partial<ConsumeArgs> & Pick<ConsumeArgs, "llm">,
): ReturnType<typeof consumeLlmStream> {
  return consumeLlmStream({
    sid: "s",
    systemPrompt: "s",
    messages: [{ role: "user", content: "hi" }],
    tools: {},
    toolChoice: "auto",
    temperature: undefined,
    repairToolCall: async () => null,
    maxSteps: 1,
    sendTtsText: () => undefined,
    callbacks: { report: () => undefined },
    emitError: () => undefined,
    log: silentLogger,
    signal: new AbortController().signal,
    onDelta: () => undefined,
    // The cover would speak into `sendTtsText`, which these specs do not read.
    deadAirCoverMs: 0,
    ...overrides,
  });
}

/** Run a turn to completion on virtual time; answers it and the virtual ms it took. */
async function timedTurn(
  overrides: Partial<ConsumeArgs> & Pick<ConsumeArgs, "llm">,
): Promise<{ result: Awaited<ReturnType<typeof consumeLlmStream>>; tookMs: number }> {
  const start = Date.now();
  let settled = false;
  const turn = consume(overrides).finally(() => {
    settled = true;
  });
  // Well past the 60 s the provider asked for, in steps, so a spec that waits
  // it out shows up as a long `tookMs` rather than a hang.
  for (let i = 0; i < 200 && !settled; i++) await vi.advanceTimersByTimeAsync(500);
  return { result: await turn, tookMs: Date.now() - start };
}

describe("requestedRetryDelayMs", () => {
  test("reads retry-after-ms, then retry-after seconds, then an HTTP date", () => {
    expect(requestedRetryDelayMs(rateLimited({ "retry-after-ms": "250" }))).toBe(250);
    expect(requestedRetryDelayMs(rateLimited({ "retry-after": "60" }))).toBe(60_000);
    const at = new Date(Date.now() + 30_000).toUTCString();
    expect(requestedRetryDelayMs(rateLimited({ "retry-after": at }))).toBeGreaterThan(28_000);
    expect(requestedRetryDelayMs(rateLimited())).toBeUndefined();
    expect(requestedRetryDelayMs(new Error("no headers"))).toBeUndefined();
  });
});

describe("consumeLlmStream — a failed provider call", () => {
  test("a 429 asking for 60 s fails the turn at once instead of waiting it out", async () => {
    const { model, callTimes } = failingThen(1, rateLimited({ "retry-after": "60" }));
    const emitError = vi.fn();
    const { result, tookMs } = await timedTurn({ llm: model, emitError });
    // No second call: a retry before the provider's window would fail too.
    expect(callTimes).toHaveLength(1);
    expect(result.failed).toBe(true);
    expect(tookMs).toBeLessThanOrEqual(LLM_RETRY_BUDGET_MS);
    expect(emitError).toHaveBeenCalledWith("llm", expect.stringContaining("Too Many Requests"), {
      fatal: false,
    });
  });

  test("a 429 asking for a short wait is retried, and the caller hears the answer", async () => {
    const { model, callTimes } = failingThen(1, rateLimited({ "retry-after": "1" }));
    let spoken = "";
    const { result } = await timedTurn({
      llm: model,
      onDelta: (d) => {
        spoken += d;
      },
    });
    expect(result.failed).toBe(false);
    expect(spoken).toBe("Your order shipped.");
    expect(callTimes).toHaveLength(2);
    expect((callTimes[1] ?? 0) - (callTimes[0] ?? 0)).toBe(1000);
  });

  test("with no retry-after, backs off 1 s then 2 s — inside the budget", async () => {
    const { model, callTimes } = failingThen(2, rateLimited({}, 503));
    const { result } = await timedTurn({ llm: model });
    expect(result.failed).toBe(false);
    expect(callTimes.map((t) => t - (callTimes[0] ?? 0))).toEqual([
      0,
      LLM_RETRY_INITIAL_DELAY_MS,
      LLM_RETRY_INITIAL_DELAY_MS * 3,
    ]);
  });

  test("the author's maxRetries still caps the attempts", async () => {
    const { model, callTimes } = failingThen(5, rateLimited({}, 503));
    const { result } = await timedTurn({ llm: model, maxRetries: 0 });
    expect(callTimes).toHaveLength(1);
    expect(result.failed).toBe(true);
  });

  test("a failure that is not retryable is not retried", async () => {
    const unauthorized = new APICallError({
      message: "Unauthorized",
      url: "https://api.cerebras.ai/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 401,
      isRetryable: false,
    });
    const { model, callTimes } = failingThen(1, unauthorized);
    const { result } = await timedTurn({ llm: model });
    expect(callTimes).toHaveLength(1);
    expect(result.failed).toBe(true);
  });

  test("a rate-limited fallback primary moves to the next model with no wait", async () => {
    const primary = failingThen(5, rateLimited({ "retry-after": "60" }), "", "cerebras");
    const secondary = failingThen(0, new Error("unused"), "From the backup.", "openai");
    const llm: LanguageModel = fallbackLanguageModel([
      { model: primary.model, kind: "cerebras" },
      { model: secondary.model, kind: "openai" },
    ]);
    let spoken = "";
    const { result } = await timedTurn({
      llm,
      onDelta: (d) => {
        spoken += d;
      },
    });
    expect(result.failed).toBe(false);
    expect(spoken).toBe("From the backup.");
    expect(primary.callTimes).toHaveLength(1);
    // The backup was asked the same virtual millisecond the primary refused.
    expect(secondary.callTimes).toEqual(primary.callTimes);
  });

  test("a request that never opens is cut by the stall clock, retries included", async () => {
    let calls = 0;
    const hanging = new MockLanguageModelV4({
      doStream: ({ abortSignal }) => {
        calls++;
        return new Promise((_, reject) => {
          abortSignal?.addEventListener("abort", () => reject(abortSignal.reason));
        });
      },
    });
    const { result, tookMs } = await timedTurn({ llm: hanging, stallTimeoutMs: 15_000 });
    // Cut, re-sent once (the stall retry), cut again — then the turn fails.
    expect(calls).toBe(2);
    expect(result.failed).toBe(true);
    expect(tookMs).toBeLessThanOrEqual(30_500);
  });
});

describe("withBoundedRetries", () => {
  test("a model given by id is left to the SDK's retry", () => {
    expect(withBoundedRetries("openai/gpt-5", { log: silentLogger, sid: "s" })).toEqual({
      model: "openai/gpt-5",
      wrapped: false,
    });
  });
});
