// Copyright 2025 the AAI authors. MIT license.

import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNdjsonConnection, type NdjsonConnection } from "./ndjson-transport.ts";
import { _internals, parseSandboxLimitsFromEnv, type SandboxVmOptions } from "./sandbox-vm.ts";
import { createTestStorage } from "./test-utils.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createTestConn(): {
  conn: NdjsonConnection;
  hostReadable: PassThrough;
  hostWritable: PassThrough;
  writtenLines: string[];
} {
  const hostReadable = new PassThrough();
  const hostWritable = new PassThrough();
  const writtenLines: string[] = [];
  hostWritable.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) writtenLines.push(line);
    }
  });
  const conn = createNdjsonConnection(hostReadable, hostWritable);
  return { conn, hostReadable, hostWritable, writtenLines };
}

function writeResponse(stream: PassThrough, id: number, result: unknown): void {
  stream.push(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

/**
 * Attach an auto-responder to hostWritable that replies to bundle/load
 * requests on hostReadable. Returns a detach function.
 */
function autorespondBundleLoad(hostWritable: PassThrough, hostReadable: PassThrough): () => void {
  const handler = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.method === "bundle/load" && msg.id != null) {
          writeResponse(hostReadable, msg.id, { ok: true });
        }
      } catch {
        // ignore parse errors
      }
    }
  };
  hostWritable.on("data", handler);
  return () => hostWritable.off("data", handler);
}

function baseOpts(overrides?: Partial<SandboxVmOptions>): SandboxVmOptions {
  return {
    slug: "test-agent",
    workerCode: 'export default { name: "test" };',
    env: { FOO: "bar" },
    harnessPath: "/tmp/harness.mjs",
    ...overrides,
  };
}

/** Wait until a JSON-RPC response with the given id appears in writtenLines. */
async function waitForResponseId(writtenLines: string[], id: number): Promise<void> {
  await vi.waitFor(() => {
    const found = writtenLines.some((l) => {
      try {
        return JSON.parse(l).id === id;
      } catch {
        return false;
      }
    });
    if (!found) throw new Error(`Response with id ${id} not found yet`);
  });
}

/** Find a parsed JSON-RPC message by id in writtenLines. */
function findResponseById(writtenLines: string[], id: number): Record<string, unknown> | undefined {
  return writtenLines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .find((m: { id?: number } | null) => m?.id === id);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("configureSandbox", () => {
  let hostReadable: PassThrough;
  let hostWritable: PassThrough;
  let writtenLines: string[];
  let conn: NdjsonConnection;

  beforeEach(() => {
    const result = createTestConn();
    hostReadable = result.hostReadable;
    hostWritable = result.hostWritable;
    writtenLines = result.writtenLines;
    conn = result.conn;
  });

  afterEach(() => {
    hostReadable.destroy();
    hostWritable.destroy();
  });

  it("sends bundle/load request during configuration", async () => {
    const opts = baseOpts();
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const detach = autorespondBundleLoad(hostWritable, hostReadable);

    const handle = await _internals.configureSandbox(conn, opts, cleanup);
    expect(handle.conn).toBe(conn);

    // Verify bundle/load was sent with correct params
    const bundleReq = writtenLines
      .map((l) => JSON.parse(l))
      .find((m: { method?: string }) => m.method === "bundle/load");
    expect(bundleReq).toBeDefined();
    expect(bundleReq.params).toEqual({
      code: opts.workerCode,
      env: opts.env,
    });

    detach();
  });

  it("registers kv/get handler that reads from storage", async () => {
    const storage = createTestStorage();
    // Pre-populate a value
    await storage.setItem("agents/test-agent/kv:existing", "hello");

    const opts = baseOpts({ kvStorage: storage, kvPrefix: "agents/test-agent/kv" });
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const detach = autorespondBundleLoad(hostWritable, hostReadable);

    const handle = await _internals.configureSandbox(conn, opts, cleanup);
    detach();

    // Simulate guest sending kv/get request for the pre-populated key
    const getReqId = 100;
    hostReadable.push(
      `${JSON.stringify({ jsonrpc: "2.0", id: getReqId, method: "kv/get", params: { key: "existing" } })}\n`,
    );

    await waitForResponseId(writtenLines, getReqId);

    const getResponse = findResponseById(writtenLines, getReqId);
    expect(getResponse).toBeDefined();
    expect(getResponse?.result).toBe("hello");

    handle.conn.dispose();
  });

  it("kv/set handler stores values in storage", async () => {
    const storage = createTestStorage();
    const opts = baseOpts({ kvStorage: storage, kvPrefix: "agents/test-agent/kv" });
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const detach = autorespondBundleLoad(hostWritable, hostReadable);

    const handle = await _internals.configureSandbox(conn, opts, cleanup);
    detach();

    // Simulate guest sending kv/set
    const setReqId = 200;
    hostReadable.push(
      `${JSON.stringify({ jsonrpc: "2.0", id: setReqId, method: "kv/set", params: { key: "newkey", value: 42 } })}\n`,
    );

    await waitForResponseId(writtenLines, setReqId);

    // Verify storage was updated
    const stored = await storage.getItem("agents/test-agent/kv:newkey");
    expect(stored).toBe(42);

    handle.conn.dispose();
  });

  it("kv/del handler removes items from storage", async () => {
    const storage = createTestStorage();
    await storage.setItem("agents/test-agent/kv:delkey", "to-delete");

    const opts = baseOpts({ kvStorage: storage, kvPrefix: "agents/test-agent/kv" });
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const detach = autorespondBundleLoad(hostWritable, hostReadable);

    const handle = await _internals.configureSandbox(conn, opts, cleanup);
    detach();

    // Send kv/del request
    const delReqId = 300;
    hostReadable.push(
      `${JSON.stringify({ jsonrpc: "2.0", id: delReqId, method: "kv/del", params: { key: "delkey" } })}\n`,
    );

    await waitForResponseId(writtenLines, delReqId);

    // Verify the item was removed
    const item = await storage.getItem("agents/test-agent/kv:delkey");
    expect(item).toBeNull();

    handle.conn.dispose();
  });

  it("does not register KV handlers when kvStorage is not provided", async () => {
    const opts = baseOpts(); // no kvStorage or kvPrefix
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const detach = autorespondBundleLoad(hostWritable, hostReadable);

    await _internals.configureSandbox(conn, opts, cleanup);
    detach();

    // Try sending a kv/get -- should get "Method not found" error response
    const reqId = 400;
    hostReadable.push(
      `${JSON.stringify({ jsonrpc: "2.0", id: reqId, method: "kv/get", params: { key: "x" } })}\n`,
    );

    await waitForResponseId(writtenLines, reqId);

    const response = findResponseById(writtenLines, reqId);
    expect(response).toBeDefined();
    expect((response as { error?: { message: string } }).error).toBeDefined();
    expect((response as { error: { message: string } }).error.message).toContain(
      "Method not found",
    );

    conn.dispose();
  });

  it("shutdown sends notification, disposes connection, and calls cleanup", async () => {
    const opts = baseOpts();
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const detach = autorespondBundleLoad(hostWritable, hostReadable);

    const handle = await _internals.configureSandbox(conn, opts, cleanup);
    detach();

    await handle.shutdown();

    // Verify shutdown notification was sent
    const shutdownMsg = writtenLines
      .map((l) => JSON.parse(l))
      .find((m: { method?: string }) => m.method === "shutdown");
    expect(shutdownMsg).toBeDefined();

    // Verify cleanup was called
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

describe("parseSandboxLimitsFromEnv", () => {
  it("returns empty object when no env vars are set", () => {
    const limits = parseSandboxLimitsFromEnv({});
    expect(limits).toEqual({});
  });

  it("parses SANDBOX_MEMORY_LIMIT_MB", () => {
    const limits = parseSandboxLimitsFromEnv({ SANDBOX_MEMORY_LIMIT_MB: "128" });
    expect(limits.memoryLimitBytes).toBe(128 * 1024 * 1024);
  });

  it("clamps SANDBOX_MEMORY_LIMIT_MB to minimum 16 MB", () => {
    const limits = parseSandboxLimitsFromEnv({ SANDBOX_MEMORY_LIMIT_MB: "1" });
    expect(limits.memoryLimitBytes).toBe(16 * 1024 * 1024);
  });

  it("clamps SANDBOX_MEMORY_LIMIT_MB to maximum 512 MB", () => {
    const limits = parseSandboxLimitsFromEnv({ SANDBOX_MEMORY_LIMIT_MB: "9999" });
    expect(limits.memoryLimitBytes).toBe(512 * 1024 * 1024);
  });

  it("parses SANDBOX_PID_LIMIT", () => {
    const limits = parseSandboxLimitsFromEnv({ SANDBOX_PID_LIMIT: "64" });
    expect(limits.pidLimit).toBe(64);
  });

  it("clamps SANDBOX_PID_LIMIT to [8, 256]", () => {
    expect(parseSandboxLimitsFromEnv({ SANDBOX_PID_LIMIT: "1" }).pidLimit).toBe(8);
    expect(parseSandboxLimitsFromEnv({ SANDBOX_PID_LIMIT: "1000" }).pidLimit).toBe(256);
  });

  it("parses SANDBOX_TMPFS_LIMIT_MB", () => {
    const limits = parseSandboxLimitsFromEnv({ SANDBOX_TMPFS_LIMIT_MB: "50" });
    expect(limits.tmpfsSizeBytes).toBe(50 * 1024 * 1024);
  });

  it("clamps SANDBOX_TMPFS_LIMIT_MB to [1, 100]", () => {
    expect(parseSandboxLimitsFromEnv({ SANDBOX_TMPFS_LIMIT_MB: "0" }).tmpfsSizeBytes).toBe(
      1 * 1024 * 1024,
    );
    expect(parseSandboxLimitsFromEnv({ SANDBOX_TMPFS_LIMIT_MB: "999" }).tmpfsSizeBytes).toBe(
      100 * 1024 * 1024,
    );
  });

  it("parses SANDBOX_CPU_TIME_LIMIT_SECS", () => {
    const limits = parseSandboxLimitsFromEnv({ SANDBOX_CPU_TIME_LIMIT_SECS: "120" });
    expect(limits.cpuTimeLimitSecs).toBe(120);
  });

  it("clamps SANDBOX_CPU_TIME_LIMIT_SECS to [10, 300]", () => {
    expect(parseSandboxLimitsFromEnv({ SANDBOX_CPU_TIME_LIMIT_SECS: "1" }).cpuTimeLimitSecs).toBe(
      10,
    );
    expect(
      parseSandboxLimitsFromEnv({ SANDBOX_CPU_TIME_LIMIT_SECS: "9999" }).cpuTimeLimitSecs,
    ).toBe(300);
  });

  it("ignores non-numeric and undefined values", () => {
    const limits = parseSandboxLimitsFromEnv({
      SANDBOX_MEMORY_LIMIT_MB: "not-a-number",
      SANDBOX_TMPFS_LIMIT_MB: undefined,
    });
    expect(limits).toEqual({});
  });

  it("treats empty string as 0 (clamped to minimum)", () => {
    // Number("") === 0, which is finite, so it gets clamped to the minimum
    const limits = parseSandboxLimitsFromEnv({ SANDBOX_PID_LIMIT: "" });
    expect(limits.pidLimit).toBe(8); // clamped to min
  });

  it("parses all env vars together", () => {
    const limits = parseSandboxLimitsFromEnv({
      SANDBOX_MEMORY_LIMIT_MB: "64",
      SANDBOX_PID_LIMIT: "32",
      SANDBOX_TMPFS_LIMIT_MB: "10",
      SANDBOX_CPU_TIME_LIMIT_SECS: "60",
    });
    expect(limits).toEqual({
      memoryLimitBytes: 64 * 1024 * 1024,
      pidLimit: 32,
      tmpfsSizeBytes: 10 * 1024 * 1024,
      cpuTimeLimitSecs: 60,
    });
  });
});

describe("createConnection", () => {
  it("throws when child process has no stdout", () => {
    const fakeChild = { stdout: null, stdin: new PassThrough() } as never;
    expect(() => _internals.createConnection(fakeChild)).toThrow("Child process missing stdio");
  });

  it("throws when child process has no stdin", () => {
    const fakeChild = { stdout: new PassThrough(), stdin: null } as never;
    expect(() => _internals.createConnection(fakeChild)).toThrow("Child process missing stdio");
  });

  it("returns an NdjsonConnection when child has stdio", () => {
    const fakeChild = {
      stdout: new PassThrough(),
      stdin: new PassThrough(),
    } as never;
    const conn = _internals.createConnection(fakeChild);
    expect(conn).toBeDefined();
    expect(typeof conn.sendRequest).toBe("function");
    expect(typeof conn.onRequest).toBe("function");
    expect(typeof conn.listen).toBe("function");
    expect(typeof conn.dispose).toBe("function");
  });
});
