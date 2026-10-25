// Copyright 2026 the AAI authors. MIT license.
/**
 * Where `aai start`'s runtime log goes: stderr in JSON mode, and a worker's
 * lines tagged with its slot with the boot dump left to slot 0.
 */

import type { Logger } from "@alexkroman1/aai-runtime";
import { describe, expect, test } from "vitest";
import { startLogger, workerLogger } from "./_start-log.ts";

function recorder(): { base: Logger; lines: string[] } {
  const lines: string[] = [];
  const at = (level: string) => (message: string) => {
    lines.push(`${level} ${message}`);
  };
  return {
    lines,
    base: { info: at("info"), warn: at("warn"), error: at("error"), debug: at("debug") },
  };
}

describe("startLogger", () => {
  test("human mode is the console logger untouched", () => {
    const { base } = recorder();
    expect(startLogger(false, base)).toBe(base);
  });

  test("JSON mode sends info through the stderr writer, so stdout keeps its one line", () => {
    const { base, lines } = recorder();
    const logger = startLogger(true, base);
    logger.info("Serving");
    logger.error("broke");
    expect(lines).toEqual(["warn Serving", "error broke"]);
  });
});

describe("workerLogger", () => {
  test("slot 0 tags every line and says what happens while it boots", () => {
    const { base, lines } = recorder();
    const { logger } = workerLogger(base, 0);
    logger.info("Session mode resolved");
    logger.warn("hm");
    expect(lines).toEqual(["info [worker 0] Session mode resolved", "warn [worker 0] hm"]);
  });

  test("another slot keeps its boot INFO quiet until booted, never its warnings", () => {
    const { base, lines } = recorder();
    const { logger, booted } = workerLogger(base, 3);
    logger.info("Session mode resolved");
    logger.warn("only this slot");
    booted();
    logger.info("LLM turn");
    expect(lines).toEqual(["warn [worker 3] only this slot", "info [worker 3] LLM turn"]);
  });
});
