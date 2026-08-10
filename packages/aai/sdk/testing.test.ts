// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { createToolContext, createUnusedDb } from "./testing.ts";

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
      "state",
    ]);
  });

  test("defaults are inert: empty env, empty state, no messages", () => {
    const ctx = createToolContext();
    expect(ctx.env).toEqual({});
    expect(ctx.state).toEqual({});
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
      state: { cart: [] },
      db,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(ctx.sessionId).toBe("fixed");
    expect(ctx.env).toEqual({ API_KEY: "k" });
    expect(ctx.state).toEqual({ cart: [] });
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

  test("state is typed by the caller", () => {
    const ctx = createToolContext<{ count: number }>({ state: { count: 3 } });
    expect(ctx.state.count).toBe(3);
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
