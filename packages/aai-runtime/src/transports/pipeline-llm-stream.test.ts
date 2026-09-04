// Copyright 2026 the AAI authors. MIT license.
// Unit specs for pipeline-llm-stream.ts: how one `streamText` turn reports a
// failure, and the request-parity property preemptive generation rests on.
//
// Moved here with the code out of pipeline-stream.test.ts.

import { APICallError, type ModelMessage, RetryError, tool } from "ai";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import type { FakeLanguageModel, ScriptedPart } from "../_fake-llm.ts";
import { createFakeLanguageModel } from "../_pipeline-test-fakes.ts";
import { makeLogger, silentLogger } from "../_test-utils.ts";
import { createContextBudget } from "./pipeline-context-budget.ts";
import { type AdoptedLlmStream, consumeLlmStream, type TapeEntry } from "./pipeline-llm-stream.ts";
import { createStreamPartHandler, type StreamPart } from "./pipeline-stream-parts.ts";

type ConsumeArgs = Parameters<typeof consumeLlmStream>[0];

/**
 * `consumeLlmStream` with the inert defaults every spec in this file shares.
 *
 * The literal it replaces was fifteen fields copied eight times, of which two
 * or three ever varied per test — so the field a spec is actually about was
 * indistinguishable from the twelve that are only there to satisfy the
 * signature, and a new required parameter meant eight edits.
 */
function consume(
  overrides: Partial<ConsumeArgs> & Pick<ConsumeArgs, "llm" | "sid">,
): ReturnType<typeof consumeLlmStream> {
  return consumeLlmStream({
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
    ...overrides,
  });
}

describe("LLM stream error reporting", () => {
  function apiError(): APICallError {
    return new APICallError({
      message: "Internal Server Error",
      url: "https://llm-gateway.assemblyai.com/v1/chat/completions",
      requestBodyValues: { model: "claude-sonnet-4-6" },
      statusCode: 500,
      responseHeaders: { "x-request-id": "06ad6271" },
      responseBody: '{"request_id":"06ad6271","message":"something went wrong","code":500}',
      isRetryable: true,
    });
  }

  test("an error part logs the HTTP diagnostics, not just the message", () => {
    const log = makeLogger();
    const handler = createStreamPartHandler({
      onDelta: () => undefined,
      sendTtsText: () => undefined,
      onToolCall: () => undefined,
      // Not a filler spec, and nothing disposes this handler: 0 keeps the
      // construction-time cover window from outliving the test.
      deadAirCoverMs: 0,
      emitError: () => undefined,
      log,
      sid: "sid-1",
    });
    handler.handle({ type: "error", error: apiError() });
    expect(log.error).toHaveBeenCalledWith("LLM stream error", {
      message: "Internal Server Error",
      sid: "sid-1",
      statusCode: 500,
      url: "https://llm-gateway.assemblyai.com/v1/chat/completions",
      requestId: "06ad6271",
      responseBody: '{"request_id":"06ad6271","message":"something went wrong","code":500}',
    });
  });

  test("unwraps a RetryError so exhausted retries still report the last status", () => {
    const log = makeLogger();
    const handler = createStreamPartHandler({
      onDelta: () => undefined,
      sendTtsText: () => undefined,
      onToolCall: () => undefined,
      // Not a filler spec, and nothing disposes this handler: 0 keeps the
      // construction-time cover window from outliving the test.
      deadAirCoverMs: 0,
      emitError: () => undefined,
      log,
      sid: "sid-2",
    });
    const last = apiError();
    handler.handle({
      type: "error",
      error: new RetryError({
        message: "Failed after 3 attempts. Last error: Internal Server Error",
        reason: "maxRetriesExceeded",
        errors: [last, last, last],
      }),
    });
    expect(log.error).toHaveBeenCalledWith(
      "LLM stream error",
      expect.objectContaining({ statusCode: 500, requestId: "06ad6271" }),
    );
  });

  test("streamText never dumps the raw error object to the console", async () => {
    // The SDK's default onError is `console.error(error)`. For a retried API
    // failure that is ~100 lines (three nested stack traces plus the whole
    // request body) — enough to evict every other line from a host's log
    // buffer, which is how this went unnoticed in production.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = makeLogger();
    await consume({
      llm: createFakeLanguageModel({ script: [{ type: "error", error: apiError() }] }),
      log,
      sid: "sid-3",
    });
    expect(consoleError).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      "LLM stream error",
      expect.objectContaining({ statusCode: 500 }),
    );
  });

  // A TURN failing is not the SESSION failing, and `onError` defaults to fatal —
  // which aai-ui answers by calling `cleanupAudio()` and ending the call. So the
  // three turn-level reporters below must all pass `{ fatal: false }`, or the
  // transport speaks `errorPhrase` ("Could you say that again?") into a
  // microphone it just had switched off. Found by the pipeline fuzz once its LLM
  // script could fail a turn; the terminal paths (`onProviderError`, the
  // provider-open rejection) stay fatal, and both call `terminate()`.
  test("an error part reports the turn failure NON-fatally", () => {
    const emitError = vi.fn();
    const handler = createStreamPartHandler({
      onDelta: () => undefined,
      sendTtsText: () => undefined,
      onToolCall: () => undefined,
      // Not a filler spec, and nothing disposes this handler: 0 keeps the
      // construction-time cover window from outliving the test.
      deadAirCoverMs: 0,
      emitError,
      log: makeLogger(),
      sid: "sid-1",
    });
    handler.handle({ type: "error", error: apiError() });
    expect(emitError).toHaveBeenCalledWith("llm", "Internal Server Error", { fatal: false });
  });

  test("a thrown LLM stream reports the turn failure NON-fatally", async () => {
    const emitError = vi.fn();
    const llm = createFakeLanguageModel({ script: [{ type: "text", text: "hi" }] });
    (llm as unknown as { doStream: () => Promise<never> }).doStream = () =>
      Promise.reject(new Error("connection reset"));
    const result = await consume({ llm, emitError, sid: "sid-5" });
    expect(result.failed).toBe(true);
    expect(emitError).toHaveBeenCalledWith("llm", "connection reset", { fatal: false });
  });

  test("reports failed: true so the caller can speak a recovery phrase", async () => {
    // A failed turn produces no text, so nothing reaches TTS and the caller
    // hears silence. The transport speaks `errorPhrase` instead — but it can
    // only do that if it can tell a failed turn from an empty successful one,
    // which the message array alone cannot express.
    const result = await consume({
      llm: createFakeLanguageModel({ script: [{ type: "error", error: apiError() }] }),
      sid: "sid-4",
    });
    expect(result.failed).toBe(true);
  });

  test("reports failed: false for a turn that completed", async () => {
    const result = await consume({
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "all good" }] }),
      sid: "sid-5",
    });
    expect(result.failed).toBe(false);
  });

  test("an aborted turn is not a failure", async () => {
    // Barge-in already has its own recovery path (persistInterruptedTurn); an
    // apology on top of a deliberate interruption would be wrong.
    const ctl = new AbortController();
    ctl.abort();
    const result = await consume({
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "hi" }] }),
      sid: "sid-6",
      signal: ctl.signal,
    });
    expect(result.failed).toBe(false);
  });
});

describe("preemptive generation: poison arriving AFTER adoption", () => {
  // `SpeculativeStream.poisoned()` is consulted once, at the adoption instant,
  // but the speculation is still streaming when a turn adopts it — so a
  // `tool-call` can land after that check passed. The speculative tool set has
  // no `execute` (toDeclaredTools), so the adopted request then dies with
  // "Tool result is missing for tool call <id>", reported against the REAL
  // turn, which speaks errorPhrase for a reply the model could have given.
  function adoptedTape(parts: readonly StreamPart[], abandon: () => void): AdoptedLlmStream {
    return {
      async *entries(): AsyncGenerator<TapeEntry> {
        for (const part of parts) yield { kind: "part", part };
      },
      steps: () => Promise.resolve([]),
      abandon,
    };
  }

  const TOOL_CALL: StreamPart = {
    type: "tool-call",
    toolCallId: "call_1bkbBKlXNrdb6Om7Kfpt5h16",
    toolName: "lookup_order",
    input: "{}",
  };

  function run(adopted: AdoptedLlmStream, spoken: string[], emitError: () => void) {
    return consume({
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "restarted reply" }] }),
      messages: [{ role: "user", content: "where is my order" }],
      sendTtsText: (text: string) => spoken.push(text),
      emitError,
      sid: "sid-late-poison",
      adopted,
    });
  }

  test("restarts the turn instead of failing it", async () => {
    const abandon = vi.fn();
    const emitError = vi.fn();
    const spoken: string[] = [];

    const result = await run(adoptedTape([TOOL_CALL], abandon), spoken, emitError);

    // The whole point: the caller hears the real reply, not errorPhrase.
    expect(result.failed).toBe(false);
    expect(emitError).not.toHaveBeenCalled();
    expect(spoken.join("")).toContain("restarted reply");
    // And the abandoned request stops being billed.
    expect(abandon).toHaveBeenCalledTimes(1);
  });

  test("does not surface the speculative tool call to the client", async () => {
    // The speculation's call can never be executed, so announcing it would put
    // a tool_call frame on the wire with no result to follow it.
    const onToolCall = vi.fn();
    await consume({
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "ok" }] }),
      callbacks: {
        report: (event) => {
          if (event.type === "tool.called")
            onToolCall(event.toolCallId, event.toolName, event.args);
        },
      },
      sid: "sid-late-poison-2",
      adopted: adoptedTape([TOOL_CALL], () => undefined),
    });
    expect(onToolCall).not.toHaveBeenCalled();
  });

  test("the abandoned run's spoken preamble does not enter the record twice", async () => {
    // The model spoke before calling its tool, which the TOOLS prompt tells it
    // not to do — but when it happens the restart regenerates that opening, so
    // the caller hears it twice. `collected` and the TTS coalescer are reset
    // here; the caller's `accumulated` cannot be, and left standing it makes
    // `finishSpokenTurn` commit the preamble twice — an agent quoting itself in
    // the transcript and in history.
    let accumulated = "";
    const spoken: string[] = [];
    await consume({
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "restarted reply" }] }),
      messages: [{ role: "user", content: "where is my order" }],
      sendTtsText: (text: string) => spoken.push(text),
      sid: "sid-late-poison-3",
      onDelta: (delta: string) => {
        accumulated += delta;
      },
      onRestart: () => {
        accumulated = "";
      },
      adopted: adoptedTape(
        [{ type: "text-delta", text: "Let me look that up. " }, TOOL_CALL],
        () => undefined,
      ),
    });
    // The caller heard the opening twice (nothing can undo that)...
    expect(spoken.join("")).toContain("Let me look that up.");
    // ...but the record holds one reply, not the preamble glued to a second.
    expect(accumulated).toBe("restarted reply");
  });

  test("a clean adopted tape is used as-is, with no restart", async () => {
    // The guard must not fire on the ordinary adoption path — that would throw
    // away every head start preemptive generation exists to buy.
    const abandon = vi.fn();
    const spoken: string[] = [];
    const result = await run(
      adoptedTape([{ type: "text-delta", text: "adopted reply" }], abandon),
      spoken,
      vi.fn(),
    );
    expect(abandon).not.toHaveBeenCalled();
    expect(spoken.join("")).toContain("adopted reply");
    expect(spoken.join("")).not.toContain("restarted reply");
    expect(result.failed).toBe(false);
  });
});

// `streamText` takes ONE `prepareStep`, and this call site has TWO things to
// say — the context budget's `messages` and `forceFinalAnswer`'s `toolChoice`.
// These drive the real assembler so a composition that silently dropped either
// one fails here rather than in production. See _prepare-step.ts.
describe("the context budget and forceFinalAnswer share the prepareStep slot", () => {
  /** The catalog's SMALLEST advertised window (32k), so a case can overflow it. */
  const SMALL_WINDOW_MODEL = "qwen3.5-4b-32k-experimental";

  /** A fake model answering `script`, presenting as a real gateway model id. */
  function modelFor(steps: ScriptedPart[][]): FakeLanguageModel {
    return Object.assign(createFakeLanguageModel({ steps }), { modelId: SMALL_WINDOW_MODEL });
  }

  /** Messages far past the 24,576-token budget that window leaves. */
  function overflowingHistory(): ModelMessage[] {
    return Array.from({ length: 6 }, (_, i) => ({
      role: "user" as const,
      content: `turn ${i} ${"payload ".repeat(10_000)}`,
    }));
  }

  /** How many messages the model was handed on `call`, system message excluded. */
  function promptSize(model: FakeLanguageModel, call: number): number {
    const prompt = model.calls[call]?.prompt;
    // A throw rather than `expect.fail`: this is a HELPER, and biome's
    // `noMisplacedAssertion` reads an assertion outside a test body as a bug.
    if (!Array.isArray(prompt)) throw new Error(`call ${call} sent no prompt array`);
    return prompt.filter((m) => (m as { role?: string }).role !== "system").length;
  }

  test("the request is trimmed and the caller's history is NOT touched", async () => {
    const llm = modelFor([[{ type: "text", text: "ok" }]]);
    const messages = overflowingHistory();
    await consume({
      llm,
      sid: "budget-1",
      messages,
      contextBudget: createContextBudget({ llm, log: silentLogger, sid: "budget-1" }),
    });
    // Trimmed on the way out…
    expect(promptSize(llm, 0)).toBeLessThan(messages.length);
    expect(promptSize(llm, 0)).toBeGreaterThan(0);
    // …and the array the transport owns — which is also what the client
    // replays, what resume persists and what `ctx.messages` hands a tool — is
    // exactly as it was. This is the whole reason the trim lives here.
    expect(messages).toHaveLength(6);
    expect(messages[0]?.content).toContain("turn 0");
  });

  test("nothing is trimmed when the model's window is unknown", async () => {
    // `createContextBudget` answers `undefined`, so `composePrepareStep` skips
    // it and the request carries the whole history — the documented fallback.
    const llm = createFakeLanguageModel({ steps: [[{ type: "text", text: "ok" }]] });
    const messages = overflowingHistory();
    await consume({
      llm,
      sid: "budget-2",
      messages,
      contextBudget: createContextBudget({ llm, log: silentLogger, sid: "budget-2" }),
    });
    expect(promptSize(llm, 0)).toBe(messages.length);
  });

  test("the forced final answer still fires on a step the budget also trimmed", async () => {
    // Both effects on ONE step: writing either preparer straight into the slot
    // deletes the other, and neither loss has a symptom until a turn stops
    // mid-chain with an empty transcript or a request overflows the window.
    const llm = modelFor([
      [{ type: "tool-call", toolCallId: "c1", toolName: "noop", input: "{}" }],
      [{ type: "text", text: "wrapped up" }],
    ]);
    const messages = overflowingHistory();
    await consume({
      llm,
      sid: "budget-3",
      messages,
      maxSteps: 1,
      tools: {
        noop: tool({ description: "Nothing", inputSchema: z.object({}), execute: () => "ok" }),
      },
      contextBudget: createContextBudget({ llm, log: silentLogger, sid: "budget-3" }),
    });
    expect(llm.calls).toHaveLength(2);
    // forceFinalAnswer's key, on the step the budget reserved…
    expect(llm.calls[1]?.toolChoice).toMatchObject({ type: "none" });
    // …and the budget's, on the same step.
    expect(promptSize(llm, 1)).toBeLessThan(messages.length);
  });
});
