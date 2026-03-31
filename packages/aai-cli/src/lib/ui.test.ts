// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { parsePort } from "./ui.ts";

describe("parsePort", () => {
  test("parses valid port", () => {
    expect(parsePort("3000")).toBe(3000);
  });

  test("parses port 0", () => {
    expect(parsePort("0")).toBe(0);
  });

  test("parses port 65535", () => {
    expect(parsePort("65535")).toBe(65_535);
  });

  test("throws on non-numeric input", () => {
    expect(() => parsePort("abc")).toThrow("Invalid port: abc");
  });

  test("throws on port above 65535", () => {
    expect(() => parsePort("70000")).toThrow("Invalid port: 70000");
  });

  test("throws on negative port", () => {
    expect(() => parsePort("-1")).toThrow("Invalid port: -1");
  });
});
