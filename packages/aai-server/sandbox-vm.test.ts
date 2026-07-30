// Copyright 2025 the AAI authors. MIT license.
/**
 * Tests for sandbox VM configuration and init metrics.
 *
 * The vector/* and kv/* RPC handler tests live in
 * sandbox-vm-rpc-handlers.test.ts; the Modal spawn backend is covered by
 * modal-sandbox.test.ts; shared helpers live in _sandbox-vm-test-utils.ts.
 */

import type { PassThrough } from "node:stream";
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
import { _internals, createSandboxVm, describeBundle, type WarmHarness } from "./sandbox-vm.ts";
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
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const opts = baseOpts();
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const warm = makeWarm(conn, cleanup);
    const detach = autorespondBundleLoadError(hostWritable, hostReadable);
    const pool = { acquire: vi.fn(async (): Promise<WarmHarness | null> => warm) };

    // The warm failure falls back to a cold spawn; make that fail identically
    // so the whole init rejects (a genuinely broken bundle breaks both paths).
    const cold = createTestConn();
    const detachCold = autorespondBundleLoadError(cold.hostWritable, cold.hostReadable);
    const coldCleanup = vi.fn().mockResolvedValue(undefined);
    const spawn = vi.fn(async () => makeWarm(cold.conn, coldCleanup));

    await expect(createSandboxVm(opts, pool, spawn)).rejects.toThrow();
    expect(spawn).toHaveBeenCalledOnce();
    expect(
      counterValue("aai_sandbox_init_failed_total", { reason: "bundle_missing" }),
    ).toBeGreaterThanOrEqual(1);
    detach();
    detachCold();
    cold.hostReadable.destroy();
    cold.hostWritable.destroy();
    consoleSpy.mockRestore();
  });

  it("falls back to a cold spawn when the warm harness fails configuration", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const opts = baseOpts();

    // Warm harness dies at bundle/load (acquired alive, dead by configure).
    const warmCleanup = vi.fn().mockResolvedValue(undefined);
    const warm = makeWarm(conn, warmCleanup);
    const detachWarm = autorespondBundleLoadError(hostWritable, hostReadable);
    const pool = { acquire: vi.fn(async (): Promise<WarmHarness | null> => warm) };

    // Cold fallback spawn succeeds.
    const cold = createTestConn();
    const detachCold = autorespondBundleLoad(cold.hostWritable, cold.hostReadable);
    const coldCleanup = vi.fn().mockResolvedValue(undefined);
    const spawn = vi.fn(async () => makeWarm(cold.conn, coldCleanup));

    const handle = await createSandboxVm(opts, pool, spawn);

    expect(spawn).toHaveBeenCalledOnce();
    expect(handle.conn).toBe(cold.conn);
    // The failed warm harness was cleaned up, not leaked.
    expect(warmCleanup).toHaveBeenCalled();
    // The successful fallback is recorded as a cold init, not a failure.
    expect(counterValue("aai_sandbox_init_failed_total", { reason: "bundle_missing" })).toBe(0);
    expect(histogramCount("aai_sandbox_init_seconds", { path: "cold" })).toBe(1);

    detachWarm();
    detachCold();
    handle.conn.dispose();
    cold.hostReadable.destroy();
    cold.hostWritable.destroy();
    consoleSpy.mockRestore();
  });
});

// ── describeBundle ───────────────────────────────────────────────────────────

describe("describeBundle", () => {
  function makeInspectFixture(loadResult: unknown) {
    const { conn, hostReadable, hostWritable, writtenLines } = createTestConn();
    const detach = (() => {
      const handler = (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.method === "bundle/load" && msg.id != null) {
            hostReadable.push(
              `${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: loadResult })}\n`,
            );
          }
        }
      };
      hostWritable.on("data", handler);
      return () => hostWritable.off("data", handler);
    })();
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const warm = makeWarm(conn, cleanup);
    const spawn = vi.fn(async () => warm);
    return { spawn, cleanup, writtenLines, detach, hostReadable, hostWritable };
  }

  it("loads the bundle in a scratch harness and returns its config", async () => {
    const fixture = makeInspectFixture({ ok: true, config: { name: "studio-agent" } });
    const config = await describeBundle(
      { harnessPath: "/tmp/harness.mjs", workerCode: "export default {};" },
      fixture.spawn,
    );
    fixture.detach();
    expect(config).toEqual({ name: "studio-agent" });
    // The harness is always torn down, and a shutdown notification was sent.
    expect(fixture.cleanup).toHaveBeenCalledTimes(1);
    expect(fixture.writtenLines.some((l) => l.includes('"shutdown"'))).toBe(true);
    fixture.hostReadable.destroy();
    fixture.hostWritable.destroy();
  });

  it("returns undefined for a bundle that does not self-describe", async () => {
    const fixture = makeInspectFixture({ ok: true });
    const config = await describeBundle(
      { harnessPath: "/tmp/harness.mjs", workerCode: "export default {};" },
      fixture.spawn,
    );
    fixture.detach();
    expect(config).toBeUndefined();
    fixture.hostReadable.destroy();
    fixture.hostWritable.destroy();
  });

  it("tears the harness down even when bundle/load rejects", async () => {
    const { conn, hostReadable, hostWritable } = createTestConn();
    const detach = autorespondBundleLoadError(hostWritable, hostReadable);
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const spawn = vi.fn(async () => makeWarm(conn, cleanup));
    await expect(
      describeBundle({ harnessPath: "/tmp/harness.mjs", workerCode: "throw 1" }, spawn),
    ).rejects.toThrow(/Worker code not found/);
    detach();
    expect(cleanup).toHaveBeenCalledTimes(1);
    hostReadable.destroy();
    hostWritable.destroy();
  });
});
