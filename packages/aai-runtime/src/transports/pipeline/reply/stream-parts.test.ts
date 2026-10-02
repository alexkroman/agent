// Copyright 2026 the AAI authors. MIT license.
// `createStreamPartHandler`: how `fullStream` parts become captions, TTS text,
// tool notifications and error reports, plus the two LLM-error formatters.
//
// The error-reporting cases that need a whole `consumeLlmStream` turn stay in
// `../llm/stream.test.ts`.

import { APICallError, RetryError } from "ai";
import { describe, expect, test, vi } from "vitest";
import { makeLogger } from "../../../_logger-test-utils.ts";
import { createStreamPartHandler, llmErrorDetails, llmErrorSentence } from "./stream-parts.ts";

function httpError(statusCode: number, message = "Internal Server Error"): APICallError {
  return new APICallError({
    message,
    url: "https://llm-gateway.assemblyai.com/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    responseHeaders: { "x-request-id": "req_1" },
    responseBody: `{"padding":"${"x".repeat(400)}"}`,
  });
}

function handler(overrides: Partial<Parameters<typeof createStreamPartHandler>[0]> = {}) {
  const deltas: string[] = [];
  const tts: { text: string; record: boolean }[] = [];
  const h = createStreamPartHandler({
    onDelta: (delta) => deltas.push(delta),
    sendTtsText: (text, opts) => tts.push({ text, record: opts?.record ?? true }),
    onToolCall: () => undefined,
    emitError: () => undefined,
    // Nothing here is a filler spec: 0 keeps the cover timer from arming.
    deadAirCoverMs: 0,
    log: makeLogger(),
    sid: "sid",
    ...overrides,
  });
  return { h, deltas, tts };
}

describe("createStreamPartHandler", () => {
  test("text segments across a text-end are separated by one space", () => {
    const { h, deltas, tts } = handler();
    h.handle({ type: "text-delta", text: "Let me look." });
    h.handle({ type: "text-end" });
    h.handle({ type: "text-delta", text: "Got it" });
    expect(deltas.join("")).toBe("Let me look. Got it");
    expect(tts.map((t) => t.text).join("")).toBe("Let me look. Got it");
  });

  test("no space is injected when either side already carries whitespace", () => {
    const { h, deltas } = handler();
    h.handle({ type: "text-delta", text: "One. " });
    h.handle({ type: "text-end" });
    h.handle({ type: "text-delta", text: "Two" });
    expect(deltas.join("")).toBe("One. Two");
  });

  test("a tool call is announced with record-shaped args and releases buffered speech", () => {
    const onToolCall = vi.fn();
    const onTtsBoundary = vi.fn();
    const { h } = handler({ onToolCall, onTtsBoundary });
    h.handle({ type: "tool-call", toolCallId: "c1", toolName: "lookup", input: { id: 7 } });
    expect(onToolCall).toHaveBeenCalledWith("c1", "lookup", { id: 7 });
    expect(onTtsBoundary).toHaveBeenCalledTimes(1);
  });

  test("a tool result reaches onToolCallDone as a string; one with no call id does not", () => {
    const onToolCallDone = vi.fn();
    const { h } = handler({ onToolCallDone });
    h.handle({ type: "tool-result", toolCallId: "c1", output: { ok: true } });
    h.handle({ type: "tool-result", output: "orphan" });
    expect(onToolCallDone.mock.calls).toEqual([["c1", '{"ok":true}']]);
  });

  test("an error part sets errored()", () => {
    const { h } = handler();
    expect(h.errored()).toBe(false);
    h.handle({ type: "error", error: new Error("boom") });
    expect(h.errored()).toBe(true);
  });

  test("speak() puts a filler line in TTS and keeps it out of the record", () => {
    const { h, deltas, tts } = handler();
    h.speak("One moment.", { record: false, interruptible: true });
    expect(deltas).toEqual([]);
    expect(tts).toEqual([{ text: "One moment.", record: false }]);
  });
});

describe("llmErrorDetails", () => {
  test("an HTTP failure yields status, url, request id and a capped body", () => {
    const details = llmErrorDetails(httpError(500));
    expect(details).toMatchObject({ statusCode: 500, requestId: "req_1" });
    expect(String(details.responseBody).length).toBe(300);
  });

  test("anything that is not an HTTP failure has no details", () => {
    expect(llmErrorDetails(new Error("tool threw"))).toEqual({});
  });
});

describe("llmErrorSentence", () => {
  test("a 403 names the rejected API key, as a 401 does", () => {
    expect(llmErrorSentence(httpError(403, "Forbidden"))).toMatch(
      /^The LLM provider rejected this agent's API key: .*Check the API key/,
    );
  });

  test("any other failure is the plain error message", () => {
    expect(llmErrorSentence(new Error("connection reset"))).toBe("connection reset");
    expect(llmErrorSentence(httpError(500))).not.toContain("API key");
  });
});

/**
 * The empty message, as a value rather than a literal — Biome's
 * `useErrorMessage` refuses an empty message literal, and it is right to. Naming
 * it beats spending one of the ratcheted lint suppressions on the value these
 * specs are about.
 */
const NO_MESSAGE = "";

/**
 * The handler's own error reporting, moved from `../llm/stream.test.ts`, which
 * keeps the cases that need a whole `consumeLlmStream` turn (a throw, and the
 * de-duplication between an error part and a throw).
 */
describe("an error part", () => {
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
});
