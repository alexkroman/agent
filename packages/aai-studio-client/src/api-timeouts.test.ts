// Copyright 2026 the AAI authors. MIT license.
// The per-request deadlines. Each value's paragraph argues a RELATION — the
// broker must outlast the cold path, the probe must be shorter than the gate
// reads, the default must outlast every screen-bound read — and those relations
// are what a retune can break without any other test noticing.

import { describe, expect, test } from "vitest";
import {
  ACCOUNT_ATTEMPT_TIMEOUT_MS,
  AGENT_LOGS_ATTEMPT_TIMEOUT_MS,
  AGENT_PAGE_PROBE_TIMEOUT_MS,
  AGENT_READ_TIMEOUT_MS,
  AUTH_CONFIG_ATTEMPT_TIMEOUT_MS,
  CHAT_SESSION_ATTEMPT_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  STATUS_ATTEMPT_TIMEOUT_MS,
} from "./api-timeouts.ts";

const ALL = {
  ACCOUNT_ATTEMPT_TIMEOUT_MS,
  AGENT_LOGS_ATTEMPT_TIMEOUT_MS,
  AGENT_PAGE_PROBE_TIMEOUT_MS,
  AGENT_READ_TIMEOUT_MS,
  AUTH_CONFIG_ATTEMPT_TIMEOUT_MS,
  CHAT_SESSION_ATTEMPT_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  STATUS_ATTEMPT_TIMEOUT_MS,
};

/** The guest dial (30s) plus the session install (60s), both capped server-side. */
const BROKER_COLD_PATH_CAPS_MS = 30_000 + 60_000;

describe("api timeouts", () => {
  test.each(Object.entries(ALL))("%s is a positive whole number of ms", (_name, ms) => {
    expect(Number.isInteger(ms)).toBe(true);
    expect(ms).toBeGreaterThan(0);
  });

  test("the broker outlasts the cold path's own server-side caps", () => {
    expect(CHAT_SESSION_ATTEMPT_TIMEOUT_MS).toBeGreaterThan(BROKER_COLD_PATH_CAPS_MS);
  });

  test("the broker is the one read allowed longer than the default", () => {
    expect(CHAT_SESSION_ATTEMPT_TIMEOUT_MS).toBeGreaterThan(DEFAULT_REQUEST_TIMEOUT_MS);
    for (const [name, ms] of Object.entries(ALL)) {
      if (name === "CHAT_SESSION_ATTEMPT_TIMEOUT_MS" || name === "DEFAULT_REQUEST_TIMEOUT_MS") {
        continue;
      }
      expect(ms, name).toBeLessThan(DEFAULT_REQUEST_TIMEOUT_MS);
    }
  });

  test("the preview probe is the shortest — a timeout there only means 'not ready yet'", () => {
    const others = Object.entries(ALL).filter(([n]) => n !== "AGENT_PAGE_PROBE_TIMEOUT_MS");
    for (const [name, ms] of others) {
      expect(AGENT_PAGE_PROBE_TIMEOUT_MS, name).toBeLessThan(ms);
    }
  });

  test("a read aimed at a deployed agent outlasts the gate reads (it may wait out a boot)", () => {
    expect(AGENT_READ_TIMEOUT_MS).toBeGreaterThan(ACCOUNT_ATTEMPT_TIMEOUT_MS);
    expect(AGENT_READ_TIMEOUT_MS).toBeGreaterThan(STATUS_ATTEMPT_TIMEOUT_MS);
  });
});
