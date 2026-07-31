// Copyright 2025 the AAI authors. MIT license.
/**
 * Tests for the db/query RPC handlers that configureSandbox
 * registers on the host↔guest RPC connection.
 *
 * Split from sandbox-vm.test.ts; shared helpers live in
 * _sandbox-vm-test-utils.ts.
 */

import type { Db } from "@alexkroman1/aai";
import { MAX_DB_RESULT_ROWS } from "@alexkroman1/aai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  autorespondBundleLoad,
  baseOpts,
  createTestConn,
  type FakeGuestSocket,
  findResponseById,
  makeWarm,
  waitForResponseId,
} from "./_sandbox-vm-test-utils.ts";
import type { GuestConnection } from "./rpc-schemas.ts";
import { _internals } from "./sandbox-vm.ts";

// ── Unregistered-method tests ─────────────────────────────────────────────────

describe("unregistered RPC methods", () => {
  let socket: FakeGuestSocket;
  let writtenLines: string[];
  let conn: GuestConnection;

  beforeEach(() => {
    const result = createTestConn();
    socket = result.socket;
    writtenLines = result.writtenLines;
    conn = result.conn;
  });

  it("answers an unknown method with Method not found", async () => {
    const opts = baseOpts();
    const cleanup = vi.fn().mockResolvedValue(undefined);
    autorespondBundleLoad(socket);

    await _internals.configureSandbox(makeWarm(conn, cleanup), opts);

    const reqId = 504;
    socket.receive({
      jsonrpc: "2.0",
      id: reqId,
      // The fetch relay is gone — a guest still speaking it gets the same
      // Method-not-found any unknown method does.
      method: "fetch/request",
      params: { id: "f1", url: "https://x.test/", method: "GET", headers: {}, body: null },
    });

    await waitForResponseId(writtenLines, reqId);

    const response = findResponseById(writtenLines, reqId);
    expect(response?.error).toBeDefined();
    expect((response as { error: { message: string } }).error.message).toContain(
      "Method not found",
    );

    conn.dispose();
  });
});

// ── db/query delegation through the injected Db ─────────────────────────────

describe("db/query handler via injected Db", () => {
  let socket: FakeGuestSocket;
  let writtenLines: string[];
  let conn: GuestConnection;

  beforeEach(() => {
    const result = createTestConn();
    socket = result.socket;
    writtenLines = result.writtenLines;
    conn = result.conn;
  });

  async function configure(db: Db) {
    const opts = baseOpts({ db });
    const cleanup = vi.fn().mockResolvedValue(undefined);
    autorespondBundleLoad(socket);
    return await _internals.configureSandbox(makeWarm(conn, cleanup), opts);
  }

  it("db/query delegates sql + params to the provided Db", async () => {
    const querySpy = vi.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]);
    const handle = await configure({ query: querySpy });

    const reqId = 601;
    socket.receive({
      jsonrpc: "2.0",
      id: reqId,
      method: "db/query",
      params: { sql: "select * from notes where id = $1", params: [1] },
    });

    await waitForResponseId(writtenLines, reqId);

    expect(querySpy).toHaveBeenCalledWith("select * from notes where id = $1", [1]);

    const response = findResponseById(writtenLines, reqId);
    expect(response?.error).toBeUndefined();
    expect(response?.result).toEqual([{ id: 1 }, { id: 2 }]);

    handle.conn.dispose();
  });

  it("db/query omits params when the guest sends none", async () => {
    const querySpy = vi.fn().mockResolvedValue([]);
    const handle = await configure({ query: querySpy });

    const reqId = 602;
    socket.receive({
      jsonrpc: "2.0",
      id: reqId,
      method: "db/query",
      params: { sql: "select 1" },
    });

    await waitForResponseId(writtenLines, reqId);

    expect(querySpy).toHaveBeenCalledWith("select 1", undefined);
    handle.conn.dispose();
  });

  it("db/query surfaces the row-cap throw from the Db handle as an RPC error", async () => {
    // The cap itself lives in createPostgresDb (which openAppDb builds the
    // handle from) — the handler forwards its throw instead of truncating.
    const capError = new Error(`query returned more than ${MAX_DB_RESULT_ROWS} rows; add a LIMIT`);
    const handle = await configure({ query: vi.fn().mockRejectedValue(capError) });

    const reqId = 603;
    socket.receive({
      jsonrpc: "2.0",
      id: reqId,
      method: "db/query",
      params: { sql: "select * from big" },
    });

    await waitForResponseId(writtenLines, reqId);

    const response = findResponseById(writtenLines, reqId);
    expect(response?.error).toBeDefined();
    expect(JSON.stringify(response?.error)).toContain("add a LIMIT");
    handle.conn.dispose();
  });

  it("db/query rejects malformed params (empty sql)", async () => {
    const querySpy = vi.fn().mockResolvedValue([]);
    const handle = await configure({ query: querySpy });

    const reqId = 604;
    socket.receive({
      jsonrpc: "2.0",
      id: reqId,
      method: "db/query",
      params: { sql: "" },
    });

    await waitForResponseId(writtenLines, reqId);

    const response = findResponseById(writtenLines, reqId);
    expect(response?.error).toBeDefined();
    expect(querySpy).not.toHaveBeenCalled();
    handle.conn.dispose();
  });
});
