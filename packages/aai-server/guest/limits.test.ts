// Copyright 2026 the AAI authors. MIT license.
// `limits.ts` is bundled into the guest and must therefore keep zero imports,
// so it cannot import the SDK constants it mirrors. These assertions are what
// stops the two sides drifting: they are the reason the duplication is safe.

import {
  STORAGE_DISABLED_MESSAGE,
  TOOL_EXECUTION_TIMEOUT_MS,
  TOOL_FETCH_MAX_REQUEST_BODY_BYTES,
} from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import * as limits from "./limits.ts";

describe("guest limits mirror the SDK constants", () => {
  test("tool execution timeout", () => {
    expect(limits.TOOL_TIMEOUT_MS).toBe(TOOL_EXECUTION_TIMEOUT_MS);
  });

  test("request body cap", () => {
    // The guest's own check is a friendly early error; the authoritative one
    // is `checkToolFetch` in the SDK, which both the platform host and
    // self-hosted mode run. A guest that rejected at a *different* size would
    // report the wrong limit to the tool author.
    expect(limits.MAX_REQUEST_BODY_BYTES).toBe(TOOL_FETCH_MAX_REQUEST_BODY_BYTES);
  });

  test("storage-disabled message", () => {
    // Dev (SDK tool-executor) and prod (guest harness) must throw the exact
    // same guidance when tool code touches ctx.db with storage off.
    expect(limits.STORAGE_DISABLED_MESSAGE).toBe(STORAGE_DISABLED_MESSAGE);
  });

  test("heartbeat cadence leaves generous slack under the orphan timeout", () => {
    // The host pings each harness every HARNESS_HEARTBEAT_INTERVAL_MS and the
    // guest exits after HARNESS_ORPHAN_TIMEOUT_MS of silence. If the interval
    // ever crept up to (or past) the timeout, a briefly stalled host event
    // loop would kill every healthy guest at once — keep >= 3 missed
    // heartbeats of slack.
    expect(limits.HARNESS_ORPHAN_TIMEOUT_MS).toBeGreaterThanOrEqual(
      limits.HARNESS_HEARTBEAT_INTERVAL_MS * 3,
    );
    // The watchdog poll bounds detection latency; it must be able to fire
    // multiple times within one timeout window.
    expect(limits.HARNESS_ORPHAN_POLL_MS).toBeLessThanOrEqual(limits.HARNESS_ORPHAN_TIMEOUT_MS / 2);
  });

  test("limits.ts stays import-free so it can be bundled into the guest", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./limits.ts", import.meta.url), "utf8"),
    );
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});
