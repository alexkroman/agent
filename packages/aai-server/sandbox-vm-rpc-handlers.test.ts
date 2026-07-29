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

// ── Hostile guest params ──────────────────────────────────────────────────────
//
// The guest is untrusted: malformed or malicious RPC params must come back as
// JSON-RPC error responses on the wire — never crash the host or reach the
// underlying Kv/Vector — and the connection must keep serving requests.

describe("hostile guest RPC params", () => {
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

  function pushRequest(id: number, method: string, paramsJson: string): void {
    // Params arrive as a raw JSON string so hostile shapes like "__proto__"
    // keys survive exactly as a compromised guest would put them on the wire
    // (a JS object literal would set the prototype instead of a property).
    hostReadable.push(`{"jsonrpc":"2.0","id":${id},"method":"${method}","params":${paramsJson}}\n`);
  }

  it("answers hostile kv/vector params with JSON-RPC errors and keeps serving", async () => {
    const kvGetSpy = vi.fn().mockResolvedValue("legit-value");
    const kvSetSpy = vi.fn().mockResolvedValue(undefined);
    const kv = { get: kvGetSpy, set: kvSetSpy, delete: vi.fn().mockResolvedValue(undefined) };
    const querySpy = vi.fn().mockResolvedValue([]);
    const vector = {
      upsert: vi.fn().mockResolvedValue(undefined),
      query: querySpy,
      delete: vi.fn().mockResolvedValue(undefined),
    };

    const opts = baseOpts({ kv, vector });
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const detach = autorespondBundleLoad(hostWritable, hostReadable);
    const handle = await _internals.configureSandbox(makeWarm(conn, cleanup), opts);
    detach();

    // Non-string key.
    pushRequest(801, "kv/set", JSON.stringify({ key: {}, value: "v" }));
    // Path traversal in the key.
    pushRequest(802, "kv/set", JSON.stringify({ key: "../../other-agent/kv/steal", value: "v" }));
    // topK as a huge string instead of a number.
    pushRequest(803, "vector/query", JSON.stringify({ text: "q", topK: "9".repeat(10_000) }));
    // Prototype-pollution-shaped payload (no valid key at all).
    pushRequest(804, "kv/set", '{"__proto__":{"polluted":true}}');

    for (const id of [801, 802, 803, 804]) {
      await waitForResponseId(writtenLines, id);
      const response = findResponseById(writtenLines, id);
      expect(response?.error, `request ${id} must fail`).toBeDefined();
      expect(response?.result).toBeUndefined();
    }

    // Nothing reached the underlying stores, and no prototype was polluted.
    expect(kvSetSpy).not.toHaveBeenCalled();
    expect(querySpy).not.toHaveBeenCalled();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    // The connection survived: a legitimate request still round-trips.
    pushRequest(805, "kv/get", JSON.stringify({ key: "legit" }));
    await waitForResponseId(writtenLines, 805);
    const ok = findResponseById(writtenLines, 805);
    expect(ok?.error).toBeUndefined();
    expect(ok?.result).toBe("legit-value");
    expect(kvGetSpy).toHaveBeenCalledWith("legit");

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
