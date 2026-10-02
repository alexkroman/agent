// Copyright 2026 the AAI authors. MIT license.
/**
 * The S2S fuzz harness: `createHarness` hands back a session past its first
 * handshake, over the fake link, with tool executions held open until a
 * command settles them — the starting state every generated run assumes.
 */

import { describe, expect, test } from "vitest";
import { createHarness, drain, FIRST_SESSION_ID } from "./_s2s-fuzz-harness.ts";

describe("createHarness", () => {
  test("opens one socket and completes the first handshake", async () => {
    const h = await createHarness({});
    try {
      expect(h.link.sockets).toHaveLength(1);
      expect(h.link.current()?.readyState).toBe(1);
      expect(h.link.current()?.sessionId).toBe(FIRST_SESSION_ID);
      expect([...h.link.issuedSessionIds]).toEqual([FIRST_SESSION_ID]);
      expect(h.declaredDead).toBeNull();
      expect(h.pendingTools).toEqual([]);
    } finally {
      await h.session.stop();
    }
  });

  test("holds a tool execution open until it is settled, then answers the provider", async () => {
    const cov: Record<string, number> = {};
    const h = await createHarness(cov);
    try {
      const sock = h.link.current();
      if (sock === undefined) throw new Error("no live socket");
      sock.deliver({ type: "reply.started", reply_id: "rep-1" });
      h.link.noteCall("call-1", sock.id, "rep-1");
      sock.deliver({ type: "tool.call", call_id: "call-1", name: "lookup", arguments: {} });
      await drain();
      expect(h.pendingTools.map((tool) => tool.callId)).toEqual(["call-1"]);
      expect(cov.toolExecuted).toBe(1);

      h.pendingTools[0]?.settle(true);
      await drain();
      expect(h.settled.has("call-1")).toBe(true);
      expect(h.pendingTools).toEqual([]);

      sock.deliver({ type: "reply.done", status: "completed" });
      await drain();
      expect(h.link.calls.get("call-1")?.answers).toBe(1);
      expect(h.events.map((event) => event.type)).toContain("tool.called");
    } finally {
      await h.session.stop();
    }
  });
});

describe("drain", () => {
  test("lets a queued microtask chain settle", async () => {
    let reached = false;
    void Promise.resolve()
      .then(() => undefined)
      .then(() => {
        reached = true;
      });
    await drain();
    expect(reached).toBe(true);
  });
});
