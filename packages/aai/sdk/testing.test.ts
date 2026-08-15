// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { createStubWorkflows, createToolContext, createUnusedDb } from "./testing.ts";

describe("createToolContext", () => {
  test("supplies every ToolContext field", () => {
    // The reason this helper exists is that a hand-rolled stub omits fields and
    // casts the gap away, so the field list is the assertion.
    const ctx = createToolContext();
    expect(Object.keys(ctx).sort()).toEqual([
      "db",
      "env",
      "generate",
      "messages",
      "send",
      "sent",
      "sessionId",
      "signal",
      "slots",
      "workflows",
    ]);
  });

  test("defaults are inert: empty env, empty slots, no messages", () => {
    const ctx = createToolContext();
    expect(ctx.env).toEqual({});
    expect(ctx.slots.read("anything")).toBeUndefined();
    expect(ctx.messages).toEqual([]);
  });

  test("each call is a distinct session", () => {
    expect(createToolContext().sessionId).not.toBe(createToolContext().sessionId);
  });

  test("an explicit sessionId makes two contexts the same session", () => {
    const a = createToolContext({ sessionId: "s1" });
    const b = createToolContext({ sessionId: "s1" });
    expect(a.sessionId).toBe(b.sessionId);
  });

  test("signal is present and never aborts", () => {
    expect(createToolContext().signal.aborted).toBe(false);
  });

  test("send records into ctx.sent in call order", () => {
    const ctx = createToolContext();
    ctx.send("first", { a: 1 });
    ctx.send("second", "text");
    expect(ctx.sent).toEqual([
      { event: "first", data: { a: 1 } },
      { event: "second", data: "text" },
    ]);
  });

  test("db rejects with a message naming the field", async () => {
    const ctx = createToolContext();
    await expect(ctx.db.query("select 1")).rejects.toThrow(/ctx\.db was not stubbed/);
  });

  test("generate rejects with a message naming the field", async () => {
    const ctx = createToolContext();
    await expect(ctx.generate({ prompt: "hi" })).rejects.toThrow(/ctx\.generate was not stubbed/);
  });

  test("overrides win over the defaults", () => {
    const db = createUnusedDb();
    const ctx = createToolContext({
      sessionId: "fixed",
      env: { API_KEY: "k" },
      db,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(ctx.sessionId).toBe("fixed");
    expect(ctx.env).toEqual({ API_KEY: "k" });
    expect(ctx.db).toBe(db);
    expect(ctx.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("a spy passed as send replaces the recorder", () => {
    const send = vi.fn();
    const ctx = createToolContext({ send });
    ctx.send("evt", 1);
    expect(send).toHaveBeenCalledWith("evt", 1);
    // The recorder is bypassed, not silently mirrored — `sent` would otherwise
    // read as a second, disagreeing record of what the tool did.
    expect(ctx.sent).toEqual([]);
  });

  test("an aborted signal can be supplied for cancellation tests", () => {
    const controller = new AbortController();
    controller.abort();
    expect(createToolContext({ signal: controller.signal }).signal.aborted).toBe(true);
  });

  test("its slot store applies the real storability check", () => {
    // NOT a stub: a template holding a `Map` in a slot has to fail in its own
    // spec rather than on the first deployment that has a database.
    const ctx = createToolContext();
    expect(() => ctx.slots.write("held", new Map(), true)).toThrow(/a Map/);
  });

  test("two contexts are two sessions, so their slots are independent", () => {
    const a = createToolContext();
    const b = createToolContext();
    a.slots.write("cart", { items: ["apple"] }, true);
    expect(b.slots.read("cart")).toBeUndefined();
    expect(a.sessionId).not.toBe(b.sessionId);
  });
});

describe("createUnusedDb", () => {
  test("every query rejects", async () => {
    const db = createUnusedDb();
    await expect(db.query("select 1")).rejects.toThrow(/not stubbed/);
    await expect(db.query("insert into t values ($1)", [1])).rejects.toThrow(/not stubbed/);
  });

  test("two instances are independent objects", () => {
    expect(createUnusedDb()).not.toBe(createUnusedDb());
  });
});

describe("createStubWorkflows", () => {
  test("an unstubbed method rejects naming itself rather than being undefined", async () => {
    const workflows = createStubWorkflows();
    await expect(workflows.start("digest", {})).rejects.toThrow(/not stubbed/);
    await expect(workflows.wakeUp("wrun_1")).rejects.toThrow(/not stubbed/);
    await expect(workflows.stream("wrun_1")).rejects.toThrow(/not stubbed/);
  });

  test("overrides win", async () => {
    const workflows = createStubWorkflows({ start: async () => "wrun_7" });
    await expect(workflows.start("digest", {})).resolves.toBe("wrun_7");
  });

  test("listing answers an empty list rather than throwing", () => {
    // Synchronous, so it cannot reject — and "this app declares none" is a
    // truthful answer for a stub.
    expect(createStubWorkflows().listing()).toEqual([]);
  });

  test("every method of the client is present", () => {
    // The whole point: a method added to `WorkflowClient` must arrive here
    // rather than being left `undefined` for whatever reaches it. Asserted as a
    // count-free presence check over the object's own keys, so this cannot pass
    // by the stub quietly shrinking.
    const workflows = createStubWorkflows();
    for (const [name, value] of Object.entries(workflows)) {
      expect(typeof value, name).toBe("function");
    }
    expect(Object.keys(workflows).sort()).toEqual([
      "cancel",
      "find",
      "get",
      "listing",
      "recent",
      "signal",
      "start",
      "stream",
      "streamTail",
      "wakeUp",
    ]);
  });
});
