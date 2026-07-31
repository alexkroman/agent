// Copyright 2025 the AAI authors. MIT license.
/**
 * Tests for sandbox VM configuration.
 *
 * The db/query RPC handler tests live in
 * sandbox-vm-rpc-handlers.test.ts; the Modal spawn backend is covered by
 * modal-sandbox.test.ts; shared helpers live in _sandbox-vm-test-utils.ts.
 */

import type { Db } from "@alexkroman1/aai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  autorespondBundleLoad,
  autorespondBundleLoadError,
  baseOpts,
  createTestConn,
  type FakeGuestSocket,
  findResponseById,
  makeWarm,
  waitForResponseId,
} from "./_sandbox-vm-test-utils.ts";
import type { GuestConnection } from "./rpc-schemas.ts";
import { _internals, createSandboxVm, describeBundle, type WarmHarness } from "./sandbox-vm.ts";

/** In-memory mock Db whose query fn is a spy. */
function createMockDb(rows: Record<string, unknown>[] = []) {
  const query = vi.fn().mockResolvedValue(rows);
  const db: Db = { query };
  return { db, query };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("configureSandbox", () => {
  let socket: FakeGuestSocket;
  let writtenLines: string[];
  let conn: GuestConnection;

  beforeEach(() => {
    const result = createTestConn();
    socket = result.socket;
    writtenLines = result.writtenLines;
    conn = result.conn;
  });

  it("sends bundle/load request during configuration", async () => {
    const opts = baseOpts();
    const cleanup = vi.fn().mockResolvedValue(undefined);
    autorespondBundleLoad(socket);

    const handle = await _internals.configureSandbox(makeWarm(conn, cleanup), opts);
    expect(handle.conn).toBe(conn);

    // Verify bundle/load was sent with correct params
    const bundleReq = socket.sentMessages().find((m) => m.method === "bundle/load");
    expect(bundleReq).toBeDefined();
    expect(bundleReq?.params).toEqual({
      code: opts.workerCode,
      env: opts.env,
      storageEnabled: false,
    });
  });

  it("registers db/query handler that queries the app db", async () => {
    const { db, query } = createMockDb([{ body: "hello" }]);

    const opts = baseOpts({ db });
    const cleanup = vi.fn().mockResolvedValue(undefined);
    autorespondBundleLoad(socket);

    const handle = await _internals.configureSandbox(makeWarm(conn, cleanup), opts);

    // bundle/load advertises storage as enabled when a db is bound.
    const bundleReq = socket.sentMessages().find((m) => m.method === "bundle/load") as {
      params: { storageEnabled: boolean };
    };
    expect(bundleReq.params.storageEnabled).toBe(true);

    // Simulate guest sending a db/query request
    const reqId = 100;
    socket.receive({
      jsonrpc: "2.0",
      id: reqId,
      method: "db/query",
      params: { sql: "select body from notes where id = $1", params: [7] },
    });

    await waitForResponseId(writtenLines, reqId);

    const response = findResponseById(writtenLines, reqId);
    expect(response?.result).toEqual([{ body: "hello" }]);
    expect(query).toHaveBeenCalledWith("select body from notes where id = $1", [7]);

    handle.conn.dispose();
  });

  it("does not register the db handler when db is not provided", async () => {
    const opts = baseOpts(); // no db
    const cleanup = vi.fn().mockResolvedValue(undefined);
    autorespondBundleLoad(socket);

    await _internals.configureSandbox(makeWarm(conn, cleanup), opts);

    // Try sending a db/query -- should get "Method not found" error response
    const reqId = 400;
    socket.receive({
      jsonrpc: "2.0",
      id: reqId,
      method: "db/query",
      params: { sql: "select 1" },
    });

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
    autorespondBundleLoad(socket);

    const handle = await _internals.configureSandbox(makeWarm(conn, cleanup), opts);

    await handle.shutdown();

    // Verify shutdown notification was sent
    const shutdownMsg = socket.sentMessages().find((m) => m.method === "shutdown");
    expect(shutdownMsg).toBeDefined();

    // Verify cleanup was called
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

// ── Warm-pool fallback ───────────────────────────────────────────────────────

describe("createSandboxVm warm-pool fallback", () => {
  let socket: FakeGuestSocket;
  let conn: GuestConnection;

  beforeEach(() => {
    const result = createTestConn();
    socket = result.socket;
    conn = result.conn;
  });

  it("configures a pooled warm harness without spawning", async () => {
    const opts = baseOpts();
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const warm = makeWarm(conn, cleanup);
    autorespondBundleLoad(socket);
    const pool = { acquire: vi.fn(async (): Promise<WarmHarness | null> => warm) };

    const handle = await createSandboxVm(opts, pool);

    expect(handle.conn).toBe(conn);
    handle.conn.dispose();
  });

  it("rejects when both the warm harness and the cold fallback fail bundle/load", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const opts = baseOpts();
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const warm = makeWarm(conn, cleanup);
    autorespondBundleLoadError(socket);
    const pool = { acquire: vi.fn(async (): Promise<WarmHarness | null> => warm) };

    // The warm failure falls back to a cold spawn; make that fail identically
    // so the whole init rejects (a genuinely broken bundle breaks both paths).
    const cold = createTestConn();
    autorespondBundleLoadError(cold.socket);
    const coldCleanup = vi.fn().mockResolvedValue(undefined);
    const spawn = vi.fn(async () => makeWarm(cold.conn, coldCleanup));

    await expect(createSandboxVm(opts, pool, spawn)).rejects.toThrow();
    expect(spawn).toHaveBeenCalledOnce();
    consoleSpy.mockRestore();
  });

  it("falls back to a cold spawn when the warm harness fails configuration", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const opts = baseOpts();

    // Warm harness dies at bundle/load (acquired alive, dead by configure).
    const warmCleanup = vi.fn().mockResolvedValue(undefined);
    const warm = makeWarm(conn, warmCleanup);
    autorespondBundleLoadError(socket);
    const pool = { acquire: vi.fn(async (): Promise<WarmHarness | null> => warm) };

    // Cold fallback spawn succeeds.
    const cold = createTestConn();
    autorespondBundleLoad(cold.socket);
    const coldCleanup = vi.fn().mockResolvedValue(undefined);
    const spawn = vi.fn(async () => makeWarm(cold.conn, coldCleanup));

    const handle = await createSandboxVm(opts, pool, spawn);

    expect(spawn).toHaveBeenCalledOnce();
    expect(handle.conn).toBe(cold.conn);
    // The failed warm harness was cleaned up, not leaked.
    expect(warmCleanup).toHaveBeenCalled();

    handle.conn.dispose();
    consoleSpy.mockRestore();
  });
});

// ── describeBundle ───────────────────────────────────────────────────────────

describe("describeBundle", () => {
  function makeInspectFixture(loadResult: unknown) {
    const { conn, socket, writtenLines } = createTestConn();
    socket.onSend((msg) => {
      if (msg.method === "bundle/load" && msg.id != null) {
        socket.receive({ jsonrpc: "2.0", id: msg.id, result: loadResult });
      }
    });
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const warm = makeWarm(conn, cleanup);
    const spawn = vi.fn(async () => warm);
    return { spawn, cleanup, writtenLines, warm };
  }

  it("loads the bundle in a scratch harness and returns its config", async () => {
    const fixture = makeInspectFixture({ ok: true, config: { name: "studio-agent" } });
    const config = await describeBundle(
      { harnessPath: "/tmp/harness.mjs", workerCode: "export default {};" },
      fixture.spawn,
    );
    expect(config).toEqual({ name: "studio-agent" });
    // The harness is always torn down, and a shutdown notification was sent.
    expect(fixture.cleanup).toHaveBeenCalledTimes(1);
    expect(fixture.writtenLines.some((l) => l.includes('"shutdown"'))).toBe(true);
  });

  it("returns undefined for a bundle that does not self-describe", async () => {
    const fixture = makeInspectFixture({ ok: true });
    const config = await describeBundle(
      { harnessPath: "/tmp/harness.mjs", workerCode: "export default {};" },
      fixture.spawn,
    );
    expect(config).toBeUndefined();
  });

  it("tears the harness down even when bundle/load rejects", async () => {
    const { conn, socket } = createTestConn();
    autorespondBundleLoadError(socket);
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const spawn = vi.fn(async () => makeWarm(conn, cleanup));
    await expect(
      describeBundle({ harnessPath: "/tmp/harness.mjs", workerCode: "throw 1" }, spawn),
    ).rejects.toThrow(/Worker code not found/);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
