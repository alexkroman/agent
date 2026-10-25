// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { createTurnCounter } from "./turn-counter.ts";

describe("createTurnCounter", () => {
  test("starts at zero and counts each committed user turn", () => {
    const turns = createTurnCounter();
    expect(turns.count).toBe(0);
    turns.committed();
    turns.committed();
    expect(turns.count).toBe(2);
  });

  test("a resume seeds it from the user messages of the restored history, and a clear resets it", () => {
    const turns = createTurnCounter();
    turns.committed();
    turns.seed([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "tool", content: "{}" },
      { role: "user", content: "again" },
    ]);
    expect(turns.count).toBe(2);
    turns.reset();
    expect(turns.count).toBe(0);
  });
});
