// Copyright 2025 the AAI authors. MIT license.
/**
 * The harness entry's own surface: control-channel dispatch and the param
 * validation in front of it.
 *
 * What used to be here too — the one-shot trial, the bundle lifecycle and
 * `bearerToken` — moved to `aai-guest-core` with the modules they test. A test
 * follows its subject: coverage attributes a file to whoever LOADS it, so specs
 * left behind in a dependent package would have read as uncovered in core and
 * seeded a floor that cannot fail.
 */

import { hostRequest, rejectAllPendingHostRequests, setHostSend } from "aai-guest-core/rpc";
import { type FakeHostChannel, installFakeHostChannel, makeState } from "aai-guest-core/test-utils";
import type { JsonRpcMessage } from "aai-guest-core/types";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { dispatchMessage, handleNotification, handleRequest } from "./harness.ts";

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

describe("control-channel dispatch", () => {
  // Covers removed methods too: `bundle/load`, `tool/execute`, and `status`
  // all left the channel and fall to the same method-not-found branch.
  test("unknown methods answer -32601", async () => {
    const state = makeState();
    await handleRequest({ jsonrpc: "2.0", id: 6, method: "bundle/load" }, state);
    expect(host.lastResponse().error?.code).toBe(-32_601);
  });

  test("dispatchMessage settles a rejecting handler as -32603", async () => {
    const state = makeState();
    // workspace/deploy validates its param shape inline, then rejects on the
    // path-escape guard in materializeWorkspace — the cheapest real
    // rejection left on the channel.
    dispatchMessage(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "workspace/deploy",
        params: { files: { "../escape": "x" }, serverUrl: "http://s", apiKey: "k" },
      } as JsonRpcMessage,
      state,
    );
    await vi.waitFor(() => {
      const last = host.lastResponse();
      expect(last.id).toBe(7);
      expect(last.error?.code).toBe(-32_603);
      expect(last.error?.message).toContain("escapes the workspace");
    });
  });

  // `dispatchMessage` routes on the SHAPE of the frame, and the two branches
  // below are the ones a request-shaped test cannot reach: a frame with an `id`
  // and no `method` is an answer to something the guest asked, and a frame with
  // a `method` and no `id` is a notification. Getting either wrong sends a
  // response into the request handler, where it answers -32601 to the host and
  // strands the promise nobody ever settles.
  test("a frame with an id and no method settles the host request it answers", async () => {
    const pending = hostRequest("studio/sync-workspace", {}, 5000);
    const asked = sent.at(-1) as { id: number };

    dispatchMessage(
      { jsonrpc: "2.0", id: asked.id, result: { ok: true } } as JsonRpcMessage,
      makeState(),
    );

    await expect(pending).resolves.toEqual({ ok: true });
  });

  test("a frame with a method and no id is a notification, not a request", () => {
    const before = sent.length;

    dispatchMessage(
      { jsonrpc: "2.0", method: "not-a-real-notification" } as JsonRpcMessage,
      makeState(),
    );

    // An unknown NOTIFICATION is dropped in silence — answering it would be
    // answering a frame that carries no id to answer.
    expect(sent).toHaveLength(before);
  });

  test("shutdown notification exits the process", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    handleNotification({ jsonrpc: "2.0", method: "shutdown" });
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test("malformed notifications are ignored", () => {
    expect(() => handleNotification({ jsonrpc: "2.0" })).not.toThrow();
  });
});

describe("control-channel param validation", () => {
  test("workspace/deploy with invalid params answers -32602 naming the method", async () => {
    const state = makeState();
    await handleRequest(
      { jsonrpc: "2.0", id: 8, method: "workspace/deploy", params: { files: "not-a-map" } },
      state,
    );
    const last = host.lastResponse();
    expect(last.id).toBe(8);
    expect(last.error?.code).toBe(-32_602);
    expect(last.error?.message).toContain("workspace/deploy: invalid params");
  });

  test("studio/session-init with invalid params answers -32602 without installing a session", async () => {
    const state = makeState();
    await handleRequest(
      {
        jsonrpc: "2.0",
        id: 9,
        method: "studio/session-init",
        // chatToken must be non-empty and maxSteps a positive integer.
        params: {
          project: "p",
          files: {},
          apiKey: "k",
          chatToken: "",
          system: "s",
          model: "m",
          maxSteps: 0,
        },
      },
      state,
    );
    const last = host.lastResponse();
    expect(last.id).toBe(9);
    expect(last.error?.code).toBe(-32_602);
    expect(last.error?.message).toContain("studio/session-init: invalid params");
    expect(state.studio).toBeNull();
  });
});
