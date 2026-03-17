import { describe, expect, test } from "vitest";
import { DEFAULT_GREETING, DEFAULT_INSTRUCTIONS, normalizeTransport } from "./types.ts";

describe("normalizeTransport", () => {
  test("returns ['websocket'] for undefined", () => {
    expect(normalizeTransport(undefined)).toEqual(["websocket"]);
  });

  test("wraps string in array", () => {
    expect(normalizeTransport("websocket")).toEqual(["websocket"]);
  });

  test("passes through array unchanged", () => {
    const input = ["websocket", "s2s"];
    expect(normalizeTransport(input)).toEqual(["websocket", "s2s"]);
  });
});

describe("constants", () => {
  test("DEFAULT_INSTRUCTIONS is a non-empty string", () => {
    expect(typeof DEFAULT_INSTRUCTIONS).toBe("string");
    expect(DEFAULT_INSTRUCTIONS.length).toBeGreaterThan(0);
  });

  test("DEFAULT_GREETING is a non-empty string", () => {
    expect(typeof DEFAULT_GREETING).toBe("string");
    expect(DEFAULT_GREETING.length).toBeGreaterThan(0);
  });
});
