// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { stopProjectServer } from "./_stop-server.ts";

describe("stopProjectServer", () => {
  test("closes the server, then flushes tracing", async () => {
    const order: string[] = [];
    await stopProjectServer(
      { close: async () => void order.push("close") },
      { shutdown: async () => void order.push("shutdown") },
    );
    expect(order).toEqual(["close", "shutdown"]);
  });

  test("still flushes tracing when the close fails, and reports the close's error", async () => {
    const order: string[] = [];
    await expect(
      stopProjectServer(
        {
          close: async () => {
            order.push("close");
            throw new Error("port still held");
          },
        },
        { shutdown: async () => void order.push("shutdown") },
      ),
    ).rejects.toThrow("port still held");
    expect(order).toEqual(["close", "shutdown"]);
  });

  test("needs no tracing", async () => {
    let closed = false;
    await stopProjectServer({ close: async () => void (closed = true) }, undefined);
    expect(closed).toBe(true);
  });
});
