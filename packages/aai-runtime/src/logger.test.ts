// Copyright 2026 the AAI authors. MIT license.
// The logger factories: the console logger's `debug` must be a no-op unless
// AAI_DEBUG enables it, so per-message hot-path logs cost nothing; the silent
// logger drops everything and carries no call history. And the transcript
// gate: a production process never logs what was said.

import { describe, expect, test, vi } from "vitest";
import {
  createConsoleLogger,
  isDebugEnv,
  isProductionEnv,
  silentLogger,
  transcriptField,
} from "./logger.ts";

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

describe("isProductionEnv", () => {
  test("a contained guest is production, whatever NODE_ENV says", () => {
    // The platform's spawners set AAI_SANDBOX_CONTAINED=1 and no NODE_ENV.
    expect(isProductionEnv({ AAI_SANDBOX_CONTAINED: "1" })).toBe(true);
    expect(isProductionEnv({ AAI_SANDBOX_CONTAINED: "1", NODE_ENV: "development" })).toBe(true);
  });

  test("NODE_ENV=production is production — a self-hosted deploy", () => {
    expect(isProductionEnv({ NODE_ENV: "production" })).toBe(true);
  });

  test("anything else is not: aai dev, the test tiers, an empty env", () => {
    expect(isProductionEnv({})).toBe(false);
    expect(isProductionEnv({ NODE_ENV: "test" })).toBe(false);
    expect(isProductionEnv({ NODE_ENV: "development", AAI_SANDBOX_CONTAINED: "0" })).toBe(false);
    expect(isProductionEnv({ AAI_SANDBOX_CONTAINED: "" })).toBe(false);
  });
});

describe("transcriptField", () => {
  test("carries the text under its key when transcript logging is enabled", () => {
    expect(transcriptField("text", "track my order PO999", true)).toEqual({
      text: "track my order PO999",
    });
  });

  test("in production carries only the length, under a `Chars` key", () => {
    // The line still says that something was said and how much — a timing
    // question survives — and never what.
    const field = transcriptField("transcript", "track my order PO999", false);
    expect(field).toEqual({ transcriptChars: 20 });
    expect(JSON.stringify(field)).not.toContain("PO999");
  });

  test("an empty transcript is still reported, as a zero", () => {
    expect(transcriptField("text", "", false)).toEqual({ textChars: 0 });
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
    // Every line is timestamped — see consoleLog.
    expect(spy).toHaveBeenCalledWith(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      "hot-path message",
      { payload: "big" },
    );
  });

  test("info/warn/error stay live regardless of the debug flag", () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = createConsoleLogger(false);
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), "i");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), "w");
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), "e");
  });
});

describe("silentLogger", () => {
  test("drops every level without reaching the console", () => {
    const spies = (["log", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    silentLogger.info("i");
    silentLogger.warn("w");
    silentLogger.error("e");
    silentLogger.debug("d");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  test("is plain functions, not spies that carry call history across tests", () => {
    expect(vi.isMockFunction(silentLogger.error)).toBe(false);
  });
});
