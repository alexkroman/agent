// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { log, parsePort, silenceOutput } from "./_ui.ts";

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

describe("silenceOutput", () => {
  test("replaces log methods with no-ops after silenceOutput()", () => {
    silenceOutput();
    // Should not throw — all methods are now no-ops
    expect(() => log.info("test")).not.toThrow();
    expect(() => log.success("test")).not.toThrow();
    expect(() => log.error("test")).not.toThrow();
    expect(() => log.warn("test")).not.toThrow();
    expect(() => log.step("test")).not.toThrow();
    expect(() => log.message("test")).not.toThrow();
  });
});
