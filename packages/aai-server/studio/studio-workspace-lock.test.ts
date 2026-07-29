// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { withWorkspaceLock } from "./studio-workspace-lock.ts";

describe("withWorkspaceLock", () => {
  test("serializes work on the same scope/project", async () => {
    const order: string[] = [];
    const gate = Promise.withResolvers<void>();
    const first = withWorkspaceLock("s", "p", async () => {
      order.push("first-start");
      await gate.promise;
      order.push("first-end");
    });
    const second = withWorkspaceLock("s", "p", async () => {
      order.push("second");
    });
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  test("different projects do not block each other", async () => {
    const gate = Promise.withResolvers<void>();
    const held = withWorkspaceLock("s", "p1", () => gate.promise);
    // Completes while p1's lock is still held.
    await expect(withWorkspaceLock("s", "p2", async () => "ok")).resolves.toBe("ok");
    gate.resolve();
    await held;
  });

  test("releases the lock when work throws", async () => {
    await expect(
      withWorkspaceLock("s", "p", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(withWorkspaceLock("s", "p", async () => "ok")).resolves.toBe("ok");
  });
});
