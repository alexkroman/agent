// Copyright 2025 the AAI authors. MIT license.
/**
 * Tests for the vector/* and kv/* RPC handlers that configureSandbox
 * registers on the host↔guest NDJSON connection.
 *
 * Split from sandbox-vm.test.ts; shared helpers live in
 * _sandbox-vm-test-utils.ts.
 */

import type { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  autorespondBundleLoad,
  baseOpts,
  createTestConn,
  findResponseById,
  makeWarm,
  waitForResponseId,
} from "./_sandbox-vm-test-utils.ts";
import type { NdjsonConnection } from "./ndjson-transport.ts";
import { _internals } from "./sandbox-vm.ts";

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

// ── fetch/request handler tests ──────────────────────────────────────────────

describe("fetch/request handler", () => {
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

  function parsedLines(): Record<string, unknown>[] {
    return writtenLines.map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it("uses the guest-supplied id for the ack and for early-rejection notifications", async () => {
    const opts = baseOpts({ allowedHosts: ["api.allowed.test"] });
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const detach = autorespondBundleLoad(hostWritable, hostReadable);

    const handle = await _internals.configureSandbox(makeWarm(conn, cleanup), opts);
    detach();

    const reqId = 701;
    hostReadable.push(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: reqId,
        method: "fetch/request",
        params: {
          id: "guest-fetch-1",
          url: "https://evil.test/steal",
          method: "GET",
          headers: {},
          body: null,
        },
      })}\n`,
    );

    await waitForResponseId(writtenLines, reqId);

    // Ack echoes the guest id.
    const response = findResponseById(writtenLines, reqId);
    expect(response?.error).toBeUndefined();
    expect(response?.result).toEqual({ id: "guest-fetch-1" });

    // The disallowed-host rejection notification carries the guest id, so
    // the guest's already-registered pendingFetches entry catches it even
    // when it is written before the ack.
    await vi.waitFor(() => {
      const errNotif = parsedLines().find((m) => m.method === "fetch/response-error");
      expect(errNotif).toBeDefined();
      expect((errNotif as { params: { id: string; message: string } }).params).toMatchObject({
        id: "guest-fetch-1",
        message: expect.stringContaining("not allowed"),
      });
    });

    handle.conn.dispose();
  });

  it("rejects a fetch/request without a guest id", async () => {
    const opts = baseOpts({ allowedHosts: ["api.allowed.test"] });
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const detach = autorespondBundleLoad(hostWritable, hostReadable);

    const handle = await _internals.configureSandbox(makeWarm(conn, cleanup), opts);
    detach();

    const reqId = 702;
    hostReadable.push(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: reqId,
        method: "fetch/request",
        params: { url: "https://api.allowed.test/", method: "GET", headers: {}, body: null },
      })}\n`,
    );

    await waitForResponseId(writtenLines, reqId);

    const response = findResponseById(writtenLines, reqId);
    expect(response?.error).toBeDefined();

    handle.conn.dispose();
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
