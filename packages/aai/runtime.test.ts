// Copyright 2025 the AAI authors. MIT license.

import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonLogger } from "./runtime.ts";

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

});
