// Copyright 2026 the AAI authors. MIT license.
// Debug-gating specs for the default console logger: `debug` must be a no-op
// unless AAI_DEBUG enables it, so per-message hot-path logs cost nothing.

import { describe, expect, test, vi } from "vitest";
import { createConsoleLogger, isDebugEnv } from "./runtime-config.ts";

describe("isDebugEnv", () => {
  test("enables on '1' and 'true' only", () => {
    expect(isDebugEnv("1")).toBe(true);
    expect(isDebugEnv("true")).toBe(true);
    expect(isDebugEnv("0")).toBe(false);
    expect(isDebugEnv("false")).toBe(false);
    expect(isDebugEnv("")).toBe(false);
    expect(isDebugEnv(undefined)).toBe(false);
  });
});

describe("createConsoleLogger", () => {
  test("debug is a no-op when debug logging is disabled", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const log = createConsoleLogger(false);
    log.debug("hot-path message", { payload: "big" });
    expect(spy).not.toHaveBeenCalled();
  });

  test("debug forwards to console.debug when enabled", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const log = createConsoleLogger(true);
    log.debug("hot-path message", { payload: "big" });
    expect(spy).toHaveBeenCalledWith("hot-path message", { payload: "big" });
  });

  test("info/warn/error stay live regardless of the debug flag", () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = createConsoleLogger(false);
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(info).toHaveBeenCalledWith("i");
    expect(warn).toHaveBeenCalledWith("w");
    expect(error).toHaveBeenCalledWith("e");
  });
});
