// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { createLogger, recordingSink, setLogSink } from "./logger.ts";

describe("createLogger", () => {
  test("prefixes the namespace and passes the context through, at each level", () => {
    const { sink, lines } = recordingSink();
    const restore = setLogSink(sink);
    const log = createLogger("sandbox.broker");
    log.debug("d");
    log.info("i", { slug: "a" });
    log.warn("w");
    log.error("e", { code: 1 });
    restore();
    expect(lines).toEqual([
      { level: "debug", msg: "sandbox.broker d" },
      { level: "info", msg: "sandbox.broker i", ctx: { slug: "a" } },
      { level: "warn", msg: "sandbox.broker w" },
      { level: "error", msg: "sandbox.broker e", ctx: { code: 1 } },
    ]);
  });

  test("reads the sink at CALL time, so a logger built before the swap still follows it", () => {
    const log = createLogger("early");
    const { sink, lines } = recordingSink();
    const restore = setLogSink(sink);
    log.info("after swap");
    restore();
    expect(lines.map((l) => l.msg)).toEqual(["early after swap"]);
  });
});

describe("setLogSink", () => {
  test("the undo restores the previous sink, nesting correctly", () => {
    const outer = recordingSink();
    const inner = recordingSink();
    const log = createLogger("ns");
    const restoreOuter = setLogSink(outer.sink);
    const restoreInner = setLogSink(inner.sink);
    log.warn("one");
    restoreInner();
    log.warn("two");
    restoreOuter();
    expect(inner.lines.map((l) => l.msg)).toEqual(["ns one"]);
    expect(outer.lines.map((l) => l.msg)).toEqual(["ns two"]);
  });
});
