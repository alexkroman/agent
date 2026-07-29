// Copyright 2025 the AAI authors. MIT license.
/**
 * Broken-pipe behavior of writeMessage lives in its own file: once the host
 * closes the guest's stdout, the module marks the pipe dead permanently and
 * drops every further write — a sticky module-level state that would poison
 * the other harness-rpc tests (the forks pool isolates modules per file).
 */
import { describe, expect, test, vi } from "vitest";

// ── Deno global shim ──────────────────────────────────────────────────────

const writtenBytes: Uint8Array[] = [];
let throwBrokenPipe = false;

(globalThis as Record<string, unknown>).Deno = {
  stdout: {
    writeSync(data: Uint8Array) {
      if (throwBrokenPipe) throw new Error("Broken pipe (os error 32)");
      writtenBytes.push(new Uint8Array(data));
      return data.byteLength;
    },
  },
  exit: vi.fn(),
  stdin: undefined,
};

const { sendResponse } = await import("./harness-rpc.ts");

describe("writeMessage on a broken stdout pipe", () => {
  test("swallows the throw, marks the pipe dead, and drops further writes", () => {
    // Host closed the pipe: the write must not throw (sendError inside
    // dispatchMessage's catch would otherwise throw again during teardown).
    throwBrokenPipe = true;
    expect(() => sendResponse(1, { ok: true })).not.toThrow();

    // Even if the pipe were somehow writable again, the connection is dead —
    // later writes are dropped rather than retried.
    throwBrokenPipe = false;
    sendResponse(2, { ok: true });
    expect(writtenBytes).toEqual([]);
  });
});
