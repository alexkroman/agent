// Copyright 2025 the AAI authors. MIT license.
/**
 * Tests for sandbox VM configuration, env-derived resource limits,
 * connection wiring, dev-mode spawn args, and init metrics.
 *
 * The vector/* and kv/* RPC handler tests live in
 * sandbox-vm-rpc-handlers.test.ts; shared helpers live in
 * _sandbox-vm-test-utils.ts.
 */

import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  autorespondBundleLoad,
  autorespondBundleLoadError,
  baseOpts,
  createTestConn,
  findResponseById,
  makeWarm,
  waitForResponseId,
} from "./_sandbox-vm-test-utils.ts";
import { registry } from "./metrics.ts";
import type { NdjsonConnection } from "./ndjson-transport.ts";
import {
  _internals,
  createSandboxVm,
  parseSandboxLimitsFromEnv,
  type WarmHarness,
} from "./sandbox-vm.ts";
import { counterValue, createMockKv, histogramCount } from "./test-utils.ts";

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
