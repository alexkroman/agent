// Copyright 2026 the AAI authors. MIT license.
// Unit specs for pipeline-llm-stream.ts: how one `streamText` turn reports a
// failure, and the request-parity property preemptive generation rests on.
//
// Moved here with the code out of pipeline-stream.test.ts.

import { APICallError, RetryError } from "ai";
import { describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel } from "../_pipeline-test-fakes.ts";
import { makeLogger, silentLogger } from "../_test-utils.ts";
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

/**
 * The empty message, as a value rather than a literal — Biome's
 * `useErrorMessage` refuses an empty message literal, and it is right to. Naming
 * it beats spending one of the ratcheted lint suppressions on the value these
 * specs are about.
 */
const NO_MESSAGE = "";

/**
 * A model whose `doStream` REJECTS — a provider refusing the request outright,
 * before a single stream part exists. No script can express that, so the fake
 * is patched.
 *
 * ONE seam, for the reason `_fake-llm.ts`'s `asFakeLanguageModel` is one: the
 * escape-hatch ratchet counts occurrences, and three identical casts in three
 * specs is a missing helper.
 */
function refusingModel(error: unknown): ReturnType<typeof createFakeLanguageModel> {
  const llm = createFakeLanguageModel({ script: [{ type: "text", text: "hi" }] });
  (llm as unknown as { doStream: () => Promise<never> }).doStream = () => Promise.reject(error);
  return llm;
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
      // The logged message is the sentence the CALLER saw, verbatim — a support
      // report quotes the banner, so the log has to be findable by it.
      message: "Internal Server Error (HTTP 500 from llm-gateway.assemblyai.com)",
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
    expect(emitError).toHaveBeenCalledWith(
      "llm",
      "Internal Server Error (HTTP 500 from llm-gateway.assemblyai.com)",
      { fatal: false },
    );
  });

  /**
   * The error a rejected key really produces, built the way the AI SDK builds
   * it: `createJsonErrorResponseHandler` copies `response.statusText` into
   * `message`, and a reason phrase is optional in HTTP/1.1 and absent from
   * HTTP/2 — so `message` is EMPTY and everything worth reading is in the other
   * fields. `sdk/utils.test.ts` covers the same shape structurally; these two
   * cases are what keep that stand-in honest.
   */
  function rejectedKeyError(): APICallError {
    return new APICallError({
      message: NO_MESSAGE,
      url: "https://llm-gateway.assemblyai.com/v1/chat/completions",
      requestBodyValues: { model: "qwen3-next-80b-a3b" },
      statusCode: 401,
      responseHeaders: { "x-request-id": "req_9" },
      responseBody: '{"error":{"message":"Invalid API key","type":"invalid_request_error"}}',
    });
  }

  test("a rejected API key names the cause instead of reporting nothing", () => {
    // The regression: this reached the browser as
    // {"type":"error.reported","code":"llm","message":"","fatal":false} — a
    // banner that says an error happened and refuses to say what, for the
    // failure a new project is most likely to hit first.
    const emitError = vi.fn();
    const handler = createStreamPartHandler({
      onDelta: () => undefined,
      sendTtsText: () => undefined,
      onToolCall: () => undefined,
      deadAirCoverMs: 0,
      emitError,
      log: makeLogger(),
      sid: "sid-401",
    });
    handler.handle({ type: "error", error: rejectedKeyError() });
    expect(emitError).toHaveBeenCalledWith(
      "llm",
      "The LLM provider rejected this agent's API key: Invalid API key (HTTP 401 from llm-gateway.assemblyai.com). Check the API key in the agent's environment.",
      { fatal: false },
    );
  });

  test("a thrown rejection reports the same sentence as the stream part", async () => {
    // A provider failure reaches the host two ways — an `error` part and a
    // throw — and a gateway can produce both for one turn. They must not
    // describe it differently.
    const emitError = vi.fn();
    const llm = refusingModel(rejectedKeyError());
    const result = await consume({ llm, emitError, sid: "sid-402" });
    expect(result.failed).toBe(true);
    expect(emitError).toHaveBeenCalledWith(
      "llm",
      "The LLM provider rejected this agent's API key: Invalid API key (HTTP 401 from llm-gateway.assemblyai.com). Check the API key in the agent's environment.",
      { fatal: false },
    );
  });

  test("exhausted retries report the LAST attempt's cause, not the retry count", () => {
    // `RetryError.message` ("Failed after 3 attempts…") states something, so
    // nothing further down gets read unless the wrapper is unwrapped — which is
    // what hid the 401 behind a sentence about retrying.
    const emitError = vi.fn();
    const handler = createStreamPartHandler({
      onDelta: () => undefined,
      sendTtsText: () => undefined,
      onToolCall: () => undefined,
      deadAirCoverMs: 0,
      emitError,
      log: makeLogger(),
      sid: "sid-403",
    });
    const last = rejectedKeyError();
    handler.handle({
      type: "error",
      error: new RetryError({
        message: "Failed after 3 attempts. Last error: ",
        reason: "maxRetriesExceeded",
        errors: [last, last, last],
      }),
    });
    expect(emitError).toHaveBeenCalledWith(
      "llm",
      expect.stringContaining("Invalid API key (HTTP 401 from llm-gateway.assemblyai.com)"),
      { fatal: false },
    );
  });

  test("one refused call is reported ONCE, by its cause", async () => {
    // A refused provider call emits an `error` part AND then throws: the AI
    // SDK's `steps` promise rejects with "No output generated. Check the stream
    // for errors.". Reported second, that vaguer sentence is what a client's
    // banner is left showing — it painted over the one naming the 401.
    const emitError = vi.fn();
    const result = await consume({
      llm: createFakeLanguageModel({ script: [{ type: "error", error: rejectedKeyError() }] }),
      emitError,
      sid: "sid-once",
    });
    expect(result.failed).toBe(true);
    expect(emitError).toHaveBeenCalledTimes(1);
    expect(emitError.mock.calls[0]?.[1]).toContain("rejected this agent's API key");
    expect(emitError.mock.calls[0]?.[1]).not.toContain("No output generated");
  });

  test("a throw with no error part before it is still reported", () => {
    // The other side of the de-duplication above: nothing named the cause yet,
    // so the catch is the only reporter there is.
    const emitError = vi.fn();
    const llm = refusingModel(rejectedKeyError());
    return consume({ llm, emitError, sid: "sid-throw-only" }).then(() => {
      expect(emitError).toHaveBeenCalledTimes(1);
    });
  });

  test("no LLM failure is ever reported with an empty message", () => {
    // The property the browser banner depends on: `SessionError.message` is
    // rendered verbatim, so "" is a UI that says an error occurred and refuses
    // to say what. Every value here is one a provider client really throws.
    const thrown: unknown[] = [
      rejectedKeyError(),
      apiError(),
      // A body-less 502 from something in front of the provider.
      new APICallError({
        message: NO_MESSAGE,
        url: "https://llm-gateway.assemblyai.com/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 502,
        responseBody: "",
      }),
      new RetryError({
        message: NO_MESSAGE,
        reason: "maxRetriesExceeded",
        errors: [rejectedKeyError()],
      }),
      new Error(NO_MESSAGE),
    ];
    for (const error of thrown) {
      const emitError = vi.fn();
      const handler = createStreamPartHandler({
        onDelta: () => undefined,
        sendTtsText: () => undefined,
        onToolCall: () => undefined,
        deadAirCoverMs: 0,
        emitError,
        log: makeLogger(),
        sid: "sid-empty",
      });
      handler.handle({ type: "error", error });
      expect.soft(emitError.mock.calls[0]?.[1]).not.toBe("");
    }
  });

  test("a thrown LLM stream reports the turn failure NON-fatally", async () => {
    const emitError = vi.fn();
    const llm = refusingModel(new Error("connection reset"));
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
