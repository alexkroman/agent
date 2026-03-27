// Copyright 2025 the AAI authors. MIT license.

import { type Span, type SpanContext, TraceFlags, trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consoleLogger, jsonLogger } from "./runtime.ts";

/** Parse the JSON line at `index` from `chunks`, failing if missing. */
function parseEntry(chunks: string[], index: number): Record<string, unknown> {
  const raw = chunks[index];
  if (raw === undefined) throw new Error(`No chunk at index ${index}`);
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("jsonLogger", () => {
  let stdoutChunks: string[];
  let stderrChunks: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  function setup() {
    stdoutChunks = [];
    stderrChunks = [];
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stdoutChunks.push(String(chunk));
        return true;
      });
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stderrChunks.push(String(chunk));
        return true;
      });
  }

  afterEach(() => {
    stdoutSpy?.mockRestore();
    stderrSpy?.mockRestore();
  });

  it("outputs single-line JSON with timestamp, level, and msg", () => {
    setup();
    jsonLogger.info("hello world");
    expect(stdoutChunks).toHaveLength(1);

    const entry = parseEntry(stdoutChunks, 0);
    expect(entry.level).toBe("info");
    expect(entry.msg).toBe("hello world");
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("includes caller-provided context fields", () => {
    setup();
    jsonLogger.info("with ctx", { sessionId: "abc", count: 3 });

    const entry = parseEntry(stdoutChunks, 0);
    expect(entry.sessionId).toBe("abc");
    expect(entry.count).toBe(3);
  });

  it("writes warn and error to stderr", () => {
    setup();
    jsonLogger.warn("a warning");
    jsonLogger.error("an error");

    expect(stderrChunks).toHaveLength(2);
    expect(parseEntry(stderrChunks, 0).level).toBe("warn");
    expect(parseEntry(stderrChunks, 1).level).toBe("error");
    expect(stdoutChunks).toHaveLength(0);
  });

  it("writes info and debug to stdout", () => {
    setup();
    jsonLogger.info("info msg");
    jsonLogger.debug("debug msg");

    expect(stdoutChunks).toHaveLength(2);
    expect(parseEntry(stdoutChunks, 0).level).toBe("info");
    expect(parseEntry(stdoutChunks, 1).level).toBe("debug");
    expect(stderrChunks).toHaveLength(0);
  });

  it("includes trace_id and span_id from active OTel span", () => {
    setup();

    const fakeSpanCtx: SpanContext = {
      traceId: "aaaabbbbccccdddd1111222233334444",
      spanId: "eeee5555ffff6666",
      traceFlags: TraceFlags.SAMPLED,
    };
    const fakeSpan = { spanContext: () => fakeSpanCtx } as Span;
    const getSpanSpy = vi.spyOn(trace, "getSpan").mockReturnValue(fakeSpan);

    jsonLogger.info("inside span");
    const entry = parseEntry(stdoutChunks, 0);
    expect(entry.trace_id).toBe("aaaabbbbccccdddd1111222233334444");
    expect(entry.span_id).toBe("eeee5555ffff6666");

    getSpanSpy.mockRestore();
  });

  it("omits trace_id and span_id when no active span", () => {
    setup();
    jsonLogger.info("no span");
    const entry = parseEntry(stdoutChunks, 0);
    expect(entry.trace_id).toBeUndefined();
    expect(entry.span_id).toBeUndefined();
  });

  it("outputs entry without context fields when ctx is omitted", () => {
    setup();
    jsonLogger.info("bare message");
    const entry = parseEntry(stdoutChunks, 0);
    expect(entry.msg).toBe("bare message");
    expect(entry.level).toBe("info");
    // Should not have extra context keys beyond timestamp/level/msg
    const keys = Object.keys(entry);
    expect(keys).toEqual(expect.arrayContaining(["timestamp", "level", "msg"]));
    expect(keys).toHaveLength(3);
  });

  it("debug level writes to stdout", () => {
    setup();
    jsonLogger.debug("debug message");
    expect(stdoutChunks).toHaveLength(1);
    expect(stderrChunks).toHaveLength(0);
    expect(parseEntry(stdoutChunks, 0).level).toBe("debug");
  });
});

describe("consoleLogger", () => {
  it("calls console.log for info with context", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    consoleLogger.info("msg", { key: "val" });
    expect(spy).toHaveBeenCalledWith("msg", { key: "val" });
    spy.mockRestore();
  });

  it("calls console.log for info without context", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    consoleLogger.info("msg");
    expect(spy).toHaveBeenCalledWith("msg");
    spy.mockRestore();
  });

  it("calls console.warn for warn with context", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    consoleLogger.warn("warning", { detail: 1 });
    expect(spy).toHaveBeenCalledWith("warning", { detail: 1 });
    spy.mockRestore();
  });

  it("calls console.warn for warn without context", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    consoleLogger.warn("warning");
    expect(spy).toHaveBeenCalledWith("warning");
    spy.mockRestore();
  });

  it("calls console.error for error with context", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    consoleLogger.error("err", { code: 500 });
    expect(spy).toHaveBeenCalledWith("err", { code: 500 });
    spy.mockRestore();
  });

  it("calls console.error for error without context", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    consoleLogger.error("err");
    expect(spy).toHaveBeenCalledWith("err");
    spy.mockRestore();
  });

  it("calls console.debug for debug with context", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    consoleLogger.debug("dbg", { v: true });
    expect(spy).toHaveBeenCalledWith("dbg", { v: true });
    spy.mockRestore();
  });

  it("calls console.debug for debug without context", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    consoleLogger.debug("dbg");
    expect(spy).toHaveBeenCalledWith("dbg");
    spy.mockRestore();
  });
});
