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
    write(data: Uint8Array) {
      if (throwBrokenPipe) return Promise.reject(new Error("Broken pipe (os error 32)"));
      writtenBytes.push(new Uint8Array(data));
      return Promise.resolve(data.byteLength);
    },
  },
  exit: vi.fn(),
  stdin: undefined,
};

const { kvAdapter, pendingHostRequests, sendResponse } = await import("./harness-rpc.ts");

describe("writeMessage on a broken stdout pipe", () => {
  test("swallows the throw, marks the pipe dead, and drops further writes", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Host closed the pipe: the write must not throw (sendError inside
    // dispatchMessage's catch would otherwise throw again during teardown).
    throwBrokenPipe = true;
    await expect(sendResponse(1, { ok: true })).resolves.toBeUndefined();

    // Even if the pipe were somehow writable again, the connection is dead —
    // later writes are dropped rather than retried.
    throwBrokenPipe = false;
    await sendResponse(2, { ok: true });
    expect(writtenBytes).toEqual([]);
    errorSpy.mockRestore();
  });

  test("hostRequest rejects synchronously once stdout is dead", async () => {
    // The pipe is dead (previous test's sticky module state; sendResponse
    // below would re-kill it either way). A guest→host RPC can never be
    // written, so it must fail fast with a clear error instead of parking a
    // pending entry for the full 30s timeout.
    await sendResponse(3, { ok: true });

    await expect(kvAdapter.get("any-key")).rejects.toThrow(
      'Host RPC "kv/get" failed: connection closed',
    );
    // No pending entry (and no timeout timer) was ever registered.
    expect(pendingHostRequests.size).toBe(0);
  });
});
