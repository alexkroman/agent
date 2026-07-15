// Copyright 2025 the AAI authors. MIT license.

import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registry } from "./metrics.ts";
import { createNdjsonConnection, type NdjsonConnection } from "./ndjson-transport.ts";
import {
  _internals,
  createSandboxVm,
  parseSandboxLimitsFromEnv,
  type SandboxVmOptions,
  type WarmHarness,
} from "./sandbox-vm.ts";
import { counterValue, createMockKv, histogramCount } from "./test-utils.ts";

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

function makeWarm(
  conn: NdjsonConnection,
  cleanup: () => Promise<void>,
): import("./sandbox-vm.ts").WarmHarness {
  return {
    conn,
    cleanup,
    alive: () => true,
    onExit: () => undefined,
  };
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

    const handle = await _internals.configureSandbox(makeWarm(conn, cleanup), opts);
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

  it("registers kv/get handler that reads from Kv", async () => {
    const kv = createMockKv();
    await kv.set("existing", "hello");

    const opts = baseOpts({ kv });
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const detach = autorespondBundleLoad(hostWritable, hostReadable);

    const handle = await _internals.configureSandbox(makeWarm(conn, cleanup), opts);
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

  it("kv/set handler stores values in Kv", async () => {
    const kv = createMockKv();
    const opts = baseOpts({ kv });
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const detach = autorespondBundleLoad(hostWritable, hostReadable);

    const handle = await _internals.configureSandbox(makeWarm(conn, cleanup), opts);
    detach();

    // Simulate guest sending kv/set
    const setReqId = 200;
    hostReadable.push(
      `${JSON.stringify({ jsonrpc: "2.0", id: setReqId, method: "kv/set", params: { key: "newkey", value: 42 } })}\n`,
    );

    await waitForResponseId(writtenLines, setReqId);

    // Verify Kv was updated
    expect(kv.set).toHaveBeenCalledWith("newkey", 42);

    handle.conn.dispose();
  });

  it("kv/del handler removes items from Kv", async () => {
    const kv = createMockKv();
    const opts = baseOpts({ kv });
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const detach = autorespondBundleLoad(hostWritable, hostReadable);

    const handle = await _internals.configureSandbox(makeWarm(conn, cleanup), opts);
    detach();

    // Send kv/del request
    const delReqId = 300;
    hostReadable.push(
      `${JSON.stringify({ jsonrpc: "2.0", id: delReqId, method: "kv/del", params: { key: "delkey" } })}\n`,
    );

    await waitForResponseId(writtenLines, delReqId);

    // Verify the item was removed
    expect(kv.delete).toHaveBeenCalledWith("delkey");

    handle.conn.dispose();
  });

  it("does not register KV handlers when kv is not provided", async () => {
    const opts = baseOpts(); // no kv
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const detach = autorespondBundleLoad(hostWritable, hostReadable);

    await _internals.configureSandbox(makeWarm(conn, cleanup), opts);
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

    const handle = await _internals.configureSandbox(makeWarm(conn, cleanup), opts);
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

describe("devSandboxSpawnArgs", () => {
  it("restricts env to PATH, HOME, NO_COLOR only", () => {
    const { env } = _internals.devSandboxSpawnArgs("/tmp/harness.mjs");
    expect(Object.keys(env)).toEqual(["PATH", "HOME", "NO_COLOR"]);
    expect(env.NO_COLOR).toBe("1");
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
  });

  it("includes --allow-read scoped to harness path", () => {
    const { args } = _internals.devSandboxSpawnArgs("/tmp/harness.mjs");
    expect(args).toContain("--allow-read=/tmp/harness.mjs");
  });

  it("includes --allow-env and --no-prompt", () => {
    const { args } = _internals.devSandboxSpawnArgs("/tmp/harness.mjs");
    expect(args).toContain("--allow-env");
    expect(args).toContain("--no-prompt");
  });

  it("passes harness path as final argument", () => {
    const { args } = _internals.devSandboxSpawnArgs("/my/path/harness.mjs");
    expect(args.at(-1)).toBe("/my/path/harness.mjs");
  });
});

// ── Init metrics ─────────────────────────────────────────────────────────────

describe("createSandboxVm metrics", () => {
  let hostReadable: PassThrough;
  let hostWritable: PassThrough;
  let conn: NdjsonConnection;

  beforeEach(() => {
    registry.resetMetrics();
    const result = createTestConn();
    hostReadable = result.hostReadable;
    hostWritable = result.hostWritable;
    conn = result.conn;
  });

  afterEach(() => {
    registry.resetMetrics();
    hostReadable.destroy();
    hostWritable.destroy();
  });

  it("observes aai_sandbox_init_seconds on successful spawn (via warm pool)", async () => {
    const opts = baseOpts();
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const warm = makeWarm(conn, cleanup);
    const detach = autorespondBundleLoad(hostWritable, hostReadable);
    const pool = { acquire: vi.fn(async (): Promise<WarmHarness | null> => warm) };

    const handle = await createSandboxVm(opts, pool);
    detach();

    expect(histogramCount("aai_sandbox_init_seconds")).toBe(1);
    expect(handle).toBeDefined();
    handle.conn.dispose();
  });

  it("increments aai_sandbox_init_failed_total{reason=bundle_missing} when bundle/load rejects", async () => {
    const opts = baseOpts();
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const warm = makeWarm(conn, cleanup);
    const detach = autorespondBundleLoadError(hostWritable, hostReadable);
    const pool = { acquire: vi.fn(async (): Promise<WarmHarness | null> => warm) };

    await expect(createSandboxVm(opts, pool)).rejects.toThrow();
    expect(
      counterValue("aai_sandbox_init_failed_total", { reason: "bundle_missing" }),
    ).toBeGreaterThanOrEqual(1);
    detach();
  });
});

// ── Vector RPC handler tests ──────────────────────────────────────────────────

describe("vector RPC handlers", () => {
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

  it("vector/upsert delegates to provided Vector", async () => {
    const upsertSpy = vi.fn().mockResolvedValue(undefined);
    const vector = {
      upsert: upsertSpy,
      query: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    const opts = baseOpts({ vector });
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const detach = autorespondBundleLoad(hostWritable, hostReadable);

    const handle = await _internals.configureSandbox(makeWarm(conn, cleanup), opts);
    detach();

    const reqId = 501;
    hostReadable.push(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: reqId,
        method: "vector/upsert",
        params: { id: "doc-1", text: "hello", metadata: { tag: "x" } },
      })}\n`,
    );

    await waitForResponseId(writtenLines, reqId);

    expect(upsertSpy).toHaveBeenCalledWith("doc-1", "hello", { tag: "x" });

    const response = findResponseById(writtenLines, reqId);
    expect(response?.error).toBeUndefined();

    handle.conn.dispose();
  });

  it("vector/query delegates and returns matches", async () => {
    const querySpy = vi.fn().mockResolvedValue([{ id: "doc-1", score: 0.9, text: "hello" }]);
    const vector = {
      upsert: vi.fn().mockResolvedValue(undefined),
      query: querySpy,
      delete: vi.fn().mockResolvedValue(undefined),
    };

    const opts = baseOpts({ vector });
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const detach = autorespondBundleLoad(hostWritable, hostReadable);

    const handle = await _internals.configureSandbox(makeWarm(conn, cleanup), opts);
    detach();

    const reqId = 502;
    hostReadable.push(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: reqId,
        method: "vector/query",
        params: { text: "hello", topK: 3 },
      })}\n`,
    );

    await waitForResponseId(writtenLines, reqId);

    expect(querySpy).toHaveBeenCalledWith("hello", { topK: 3 });

    const response = findResponseById(writtenLines, reqId);
    expect(response?.error).toBeUndefined();
    expect(response?.result).toEqual([{ id: "doc-1", score: 0.9, text: "hello" }]);

    handle.conn.dispose();
  });

  it("vector/delete delegates", async () => {
    const deleteSpy = vi.fn().mockResolvedValue(undefined);
    const vector = {
      upsert: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      delete: deleteSpy,
    };

    const opts = baseOpts({ vector });
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const detach = autorespondBundleLoad(hostWritable, hostReadable);

    const handle = await _internals.configureSandbox(makeWarm(conn, cleanup), opts);
    detach();

    const reqId = 503;
    hostReadable.push(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: reqId,
        method: "vector/delete",
        params: { ids: "doc-1" },
      })}\n`,
    );

    await waitForResponseId(writtenLines, reqId);

    expect(deleteSpy).toHaveBeenCalledWith("doc-1");

    const response = findResponseById(writtenLines, reqId);
    expect(response?.error).toBeUndefined();

    handle.conn.dispose();
  });

  it("does not register vector handlers when vector is not provided", async () => {
    const opts = baseOpts(); // no vector
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const detach = autorespondBundleLoad(hostWritable, hostReadable);

    await _internals.configureSandbox(makeWarm(conn, cleanup), opts);
    detach();

    const reqId = 504;
    hostReadable.push(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: reqId,
        method: "vector/upsert",
        params: { id: "x", text: "hello" },
      })}\n`,
    );

    await waitForResponseId(writtenLines, reqId);

    const response = findResponseById(writtenLines, reqId);
    expect(response?.error).toBeDefined();
    expect((response as { error: { message: string } }).error.message).toContain(
      "Method not found",
    );

    conn.dispose();
  });
});

// ── kv/* delegation through resolved Kv tests ────────────────────────────────

describe("kv/* handlers via injected Kv", () => {
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

  it("kv/get delegates to provided Kv instance", async () => {
    const getSpy = vi.fn().mockResolvedValue("injected-value");
    const kv = {
      get: getSpy,
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    const opts = baseOpts({ kv });
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const detach = autorespondBundleLoad(hostWritable, hostReadable);

    const handle = await _internals.configureSandbox(makeWarm(conn, cleanup), opts);
    detach();

    const reqId = 601;
    hostReadable.push(
      `${JSON.stringify({ jsonrpc: "2.0", id: reqId, method: "kv/get", params: { key: "mykey" } })}\n`,
    );

    await waitForResponseId(writtenLines, reqId);

    expect(getSpy).toHaveBeenCalledWith("mykey");

    const response = findResponseById(writtenLines, reqId);
    expect(response?.result).toBe("injected-value");

    handle.conn.dispose();
  });

  it("kv/set delegates to provided Kv instance", async () => {
    const setSpy = vi.fn().mockResolvedValue(undefined);
    const kv = {
      get: vi.fn().mockResolvedValue(null),
      set: setSpy,
      delete: vi.fn().mockResolvedValue(undefined),
    };

    const opts = baseOpts({ kv });
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const detach = autorespondBundleLoad(hostWritable, hostReadable);

    const handle = await _internals.configureSandbox(makeWarm(conn, cleanup), opts);
    detach();

    const reqId = 602;
    hostReadable.push(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: reqId,
        method: "kv/set",
        params: { key: "mykey", value: "myvalue" },
      })}\n`,
    );

    await waitForResponseId(writtenLines, reqId);

    expect(setSpy).toHaveBeenCalledWith("mykey", "myvalue");

    const response = findResponseById(writtenLines, reqId);
    expect(response?.error).toBeUndefined();

    handle.conn.dispose();
  });

  it("kv/set forwards expireIn (TTL) to the Kv instance", async () => {
    const setSpy = vi.fn().mockResolvedValue(undefined);
    const kv = {
      get: vi.fn().mockResolvedValue(null),
      set: setSpy,
      delete: vi.fn().mockResolvedValue(undefined),
    };

    const opts = baseOpts({ kv });
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const detach = autorespondBundleLoad(hostWritable, hostReadable);

    const handle = await _internals.configureSandbox(makeWarm(conn, cleanup), opts);
    detach();

    const reqId = 603;
    hostReadable.push(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: reqId,
        method: "kv/set",
        params: { key: "ttlkey", value: "v", expireIn: 60_000 },
      })}\n`,
    );

    await waitForResponseId(writtenLines, reqId);

    expect(setSpy).toHaveBeenCalledWith("ttlkey", "v", { expireIn: 60_000 });

    handle.conn.dispose();
  });

  it("kv/del delegates to provided Kv instance", async () => {
    const deleteSpy = vi.fn().mockResolvedValue(undefined);
    const kv = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      delete: deleteSpy,
    };

    const opts = baseOpts({ kv });
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const detach = autorespondBundleLoad(hostWritable, hostReadable);

    const handle = await _internals.configureSandbox(makeWarm(conn, cleanup), opts);
    detach();

    const reqId = 603;
    hostReadable.push(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: reqId,
        method: "kv/del",
        params: { key: "mykey" },
      })}\n`,
    );

    await waitForResponseId(writtenLines, reqId);

    expect(deleteSpy).toHaveBeenCalledWith("mykey");

    const response = findResponseById(writtenLines, reqId);
    expect(response?.error).toBeUndefined();

    handle.conn.dispose();
  });
});

/** Reject every bundle/load request with a "Worker code not found" error. */
function autorespondBundleLoadError(
  hostWritable: PassThrough,
  hostReadable: PassThrough,
): () => void {
  const handler = (chunk: Buffer) => onBundleLoadReject(chunk, hostReadable);
  hostWritable.on("data", handler);
  return () => hostWritable.off("data", handler);
}

function onBundleLoadReject(chunk: Buffer, hostReadable: PassThrough): void {
  for (const line of chunk.toString().split("\n")) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.method === "bundle/load" && msg.id != null) {
        hostReadable.push(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32_603, message: "Worker code not found" },
          })}\n`,
        );
      }
    } catch {
      // ignore
    }
  }
}
