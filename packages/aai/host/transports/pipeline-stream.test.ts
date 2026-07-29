// Copyright 2026 the AAI authors. MIT license.
// Unit specs for the pure stream helpers in pipeline-stream.ts. Turn-level
// behavior (settle window, aggregation) lives in pipeline-turn.test.ts.

import { APICallError, RetryError } from "ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  DEAD_AIR_COVER_PHRASES,
  DEFAULT_DEAD_AIR_COVER_MS,
  TTS_COALESCE_MAX_CHARS,
} from "../../sdk/constants.ts";
import { createFakeLanguageModel } from "../_pipeline-test-fakes.ts";
import { makeLogger, silentLogger } from "../_test-utils.ts";
import { consumeLlmStream, createTtsTextCoalescer } from "./pipeline-stream.ts";
import { createStreamPartHandler } from "./pipeline-stream-parts.ts";

describe("createTtsTextCoalescer", () => {
  function collect(): { sent: string[]; send: (text: string) => void } {
    const sent: string[] = [];
    return { sent, send: (text) => sent.push(text) };
  }

  test("forwards the first chunk immediately (time-to-first-byte)", () => {
    const { sent, send } = collect();
    const c = createTtsTextCoalescer(send);
    c.send("Hello ");
    expect(sent).toEqual(["Hello "]);
  });

  test("boundary() releases a sub-threshold fragment instead of stranding it", () => {
    const { sent, send } = collect();
    const c = createTtsTextCoalescer(send);
    // A turn that opens with speech, then calls a tool: "let me" is short and
    // unpunctuated, so batching would hold it for the whole tool-execution
    // window — the caller hears "Sure," then dead air.
    c.send("Sure, ");
    c.send("let me");
    expect(sent).toEqual(["Sure, "]);
    c.boundary();
    expect(sent).toEqual(["Sure, ", "let me"]);
  });

  test("boundary() re-arms the immediate first chunk for the post-tool reply", () => {
    const { sent, send } = collect();
    const c = createTtsTextCoalescer(send);
    c.send("Checking. ");
    c.boundary();
    // Time-to-first-audio matters again after the tool gap, so the next
    // segment's opening words must not wait on a clause boundary.
    c.send("I ");
    expect(sent).toEqual(["Checking. ", "I "]);
    // ...and batching resumes from there.
    c.send("found ");
    c.send("three ");
    expect(sent).toEqual(["Checking. ", "I "]);
    c.flush();
    expect(sent).toEqual(["Checking. ", "I ", "found three "]);
  });

  test("boundary() on an empty buffer emits nothing", () => {
    const { sent, send } = collect();
    const c = createTtsTextCoalescer(send);
    c.boundary();
    expect(sent).toEqual([]);
  });

  test("batches subsequent words to a clause/punctuation boundary", () => {
    const { sent, send } = collect();
    const c = createTtsTextCoalescer(send);
    for (const word of ["Sure, ", "I ", "can ", "help, ", "what's ", "up? ", "Ask ", "away."]) {
      c.send(word);
    }
    // First word immediate; then batches flush at each trailing punctuation mark.
    expect(sent).toEqual(["Sure, ", "I can help, ", "what's up? ", "Ask away."]);
    expect(sent.join("")).toBe("Sure, I can help, what's up? Ask away.");
  });

  test("flushes once the pending batch reaches TTS_COALESCE_MAX_CHARS without punctuation", () => {
    const { sent, send } = collect();
    const c = createTtsTextCoalescer(send);
    c.send("first ");
    const word = "aaaa "; // 5 chars, no punctuation
    const wordsToCap = Math.ceil(TTS_COALESCE_MAX_CHARS / word.length);
    for (let i = 0; i < wordsToCap; i++) c.send(word);
    expect(sent.length).toBe(2); // first chunk + one size-capped batch
    expect(sent[1]?.length).toBeGreaterThanOrEqual(TTS_COALESCE_MAX_CHARS);
  });

  test("flush() sends any trailing fragment and is a no-op when empty", () => {
    const { sent, send } = collect();
    const c = createTtsTextCoalescer(send);
    c.send("One ");
    c.send("more ");
    c.send("thing");
    c.flush();
    expect(sent.join("")).toBe("One more thing");
    const count = sent.length;
    c.flush();
    expect(sent.length).toBe(count);
  });

  test("empty deltas are ignored and do not consume the immediate first send", () => {
    const { sent, send } = collect();
    const c = createTtsTextCoalescer(send);
    c.send("");
    c.send("Hi ");
    expect(sent).toEqual(["Hi "]);
  });
});

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
    await consumeLlmStream({
      llm: createFakeLanguageModel({ script: [{ type: "error", error: apiError() }] }),
      systemPrompt: "s",
      messages: [{ role: "user", content: "hi" }],
      tools: {},
      toolChoice: "auto",
      temperature: undefined,
      repairToolCall: async () => null,
      maxSteps: 1,
      sendTtsText: () => undefined,
      callbacks: { onToolCall: () => undefined },
      emitError: () => undefined,
      log,
      sid: "sid-3",
      ctl: new AbortController(),
      onDelta: () => undefined,
    });
    expect(consoleError).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      "LLM stream error",
      expect.objectContaining({ statusCode: 500 }),
    );
  });
});

describe("createStreamPartHandler dead-air cover", () => {
  function harness(overrides: { holdPhrase?: string; signal?: AbortSignal } = {}) {
    const spoken: string[] = [];
    const handler = createStreamPartHandler({
      onDelta: () => undefined,
      // Route through a real coalescer: a filler that only reaches the batch
      // buffer is not speech, and the tool window is exactly when nothing
      // arrives to flush it.
      sendTtsText: createTtsTextCoalescer((t) => spoken.push(t)).send,
      onTtsBoundary: () => undefined,
      onToolCall: () => undefined,
      emitError: () => undefined,
      log: silentLogger,
      sid: "t",
      ...overrides,
    });
    const toolCall = (id: string): void =>
      handler.handle({ type: "tool-call", toolCallId: id, toolName: "lookup", input: {} });
    return { spoken, handler, toolCall };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("covers a tool window that opens after the model has already spoken", () => {
    // The failure this exists for: the model says "Let me check that", then
    // chains tool calls for 15+ seconds. holdPhrase is state-gated on "has the
    // model spoken this turn", so it stays suppressed and the caller hears
    // nothing until the chain ends — by which point they have hung up.
    const { spoken, toolCall, handler } = harness();
    handler.handle({ type: "text-delta", text: "Let me check that for you. " });
    handler.handle({ type: "text-end" });
    toolCall("tc-1");
    expect(spoken.join("")).toBe("Let me check that for you. ");
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS);
    expect(spoken.join("")).toContain(DEAD_AIR_COVER_PHRASES[0]);
  });

  test("keeps covering a long tool chain, backing off between fillers", () => {
    const { spoken, toolCall } = harness();
    toolCall("tc-1"); // opens with a tool call: holdPhrase fires immediately
    const covers = (): number =>
      DEAD_AIR_COVER_PHRASES.filter((p) => spoken.join("").includes(p)).length;
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS);
    expect(covers()).toBe(1);
    // Backoff: the second cover is not due at another single window.
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS);
    expect(covers()).toBe(1);
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS * 8);
    expect(covers()).toBeGreaterThanOrEqual(2);
  });

  test("speech cancels a pending cover", () => {
    const { spoken, toolCall, handler } = harness();
    toolCall("tc-1");
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS - 1);
    handler.handle({ type: "text-delta", text: "Found it. " });
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS * 10);
    for (const phrase of DEAD_AIR_COVER_PHRASES) {
      expect(spoken.join("")).not.toContain(phrase);
    }
  });

  test("dispose() stops a cover from firing into the silence after the turn", () => {
    const { spoken, toolCall, handler } = harness();
    toolCall("tc-1");
    handler.dispose();
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS * 10);
    for (const phrase of DEAD_AIR_COVER_PHRASES) {
      expect(spoken.join("")).not.toContain(phrase);
    }
  });

  test("a barge-in abort stops a pending cover from firing", () => {
    // Barge-in during a tool execution: dispose() waits on the parked
    // fullStream read, so the abort signal is what must kill the timer —
    // otherwise the filler is spoken into post-cancel silence AND appended
    // to `accumulated`, polluting the interrupted-turn history.
    const ctl = new AbortController();
    const { spoken, toolCall } = harness({ signal: ctl.signal });
    toolCall("tc-1");
    ctl.abort();
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS * 10);
    for (const phrase of DEAD_AIR_COVER_PHRASES) {
      expect(spoken.join("")).not.toContain(phrase);
    }
  });

  test("an unaborted signal leaves the cover working", () => {
    const ctl = new AbortController();
    const { spoken, toolCall } = harness({ signal: ctl.signal });
    toolCall("tc-1");
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS);
    expect(spoken.join("")).toContain(DEAD_AIR_COVER_PHRASES[0]);
  });

  test("holdPhrase '' disables the dead-air cover too", () => {
    // One kill switch for filler speech, not two.
    const { spoken, toolCall } = harness({ holdPhrase: "" });
    toolCall("tc-1");
    vi.advanceTimersByTime(DEFAULT_DEAD_AIR_COVER_MS * 10);
    expect(spoken).toEqual([]);
  });
});
