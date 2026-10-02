// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { DEFAULT_GREETING } from "./agent-defaults.ts";
import { agent } from "./define.ts";

describe("DEFAULT_GREETING", () => {
  test("DEFAULT_GREETING is a non-empty string", () => {
    expect(typeof DEFAULT_GREETING).toBe("string");
    expect(DEFAULT_GREETING.length).toBeGreaterThan(0);
  });

  test("is what agent() speaks when no greeting is declared", () => {
    expect(agent({ name: "g" }).greeting).toBe(DEFAULT_GREETING);
  });
});
