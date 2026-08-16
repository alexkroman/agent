// Copyright 2025 the AAI authors. MIT license.
/**
 * Tests for the guest's host-RPC layer: the outbound send path, the pending
 * host-request proxy (studio workspace sync / chat persistence), and
 * teardown.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type FakeHostChannel, installFakeHostChannel } from "./_test-utils.ts";
import {
  handleHostResponse,
  hostRequest,
  pendingHostRequests,
  rejectAllPendingHostRequests,
  sendError,
  sendResponse,
  setHostSend,
  writeMessage,
} from "./harness-rpc.ts";

let host: FakeHostChannel;
let sent: FakeHostChannel["sent"];

beforeEach(() => {
  host = installFakeHostChannel();
  sent = host.sent;
});

afterEach(() => {
  rejectAllPendingHostRequests("test teardown");
  setHostSend(null);
});

describe("outbound send path", () => {
  test("writeMessage forwards frames to the installed host socket", () => {
    writeMessage({ jsonrpc: "2.0", method: "x" });
    expect(sent).toEqual([{ jsonrpc: "2.0", method: "x" }]);
  });

  test("messages sent with no host connected are dropped, not queued", () => {
    setHostSend(null);
    expect(() => sendResponse(1, { ok: true })).not.toThrow();
    sent = installFakeHostChannel().sent;
    sendResponse(2, { ok: true });
    // Only the post-reconnect frame arrives — nothing replayed.
    expect(sent).toEqual([{ jsonrpc: "2.0", id: 2, result: { ok: true } }]);
  });

  test("sendResponse / sendError produce the wire shapes", () => {
    sendResponse(5, { ok: true });
    sendError(6, -32_000, "nope");
    expect(sent).toEqual([
      { jsonrpc: "2.0", id: 5, result: { ok: true } },
      { jsonrpc: "2.0", id: 6, error: { code: -32_000, message: "nope" } },
    ]);
  });
});

describe("host request proxy", () => {
  test("hostRequest round-trips a request through the host socket", async () => {
    const pending = hostRequest("studio/sync-workspace", { files: {} });
    const req = host.lastRequest();
    expect(req.method).toBe("studio/sync-workspace");
    expect(req.params).toEqual({ files: {} });
    host.answerLast({ ok: true });
    await expect(pending).resolves.toEqual({ ok: true });
    expect(pendingHostRequests.size).toBe(0);
  });

  test("a host error response rejects the pending call", async () => {
    const pending = hostRequest("studio/persist-chat", {});
    host.answerLast(undefined, { code: -32_603, message: "store down" });
    await expect(pending).rejects.toThrow(/store down/);
  });

  test("rejectAllPendingHostRequests fails every pending call", async () => {
    const a = hostRequest("studio/sync-workspace", {});
    const b = hostRequest("studio/persist-chat", {});
    rejectAllPendingHostRequests("Connection closed");
    await expect(a).rejects.toThrow(/Connection closed/);
    await expect(b).rejects.toThrow(/Connection closed/);
    expect(pendingHostRequests.size).toBe(0);
  });

  test("a response for an unknown id is ignored", () => {
    expect(() => handleHostResponse({ id: 424_242, result: "?" })).not.toThrow();
  });
});
