// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  STEP_FETCH_CONNECTIONS,
  STEP_FETCH_INACTIVITY_MS,
  STEP_FETCH_KEEP_ALIVE_MS,
  STEP_FETCH_PIPELINING,
} from "./step-fetch-constants.ts";

describe("step fetch pool", () => {
  test("pipelines nothing — one request per connection at a time", () => {
    expect(STEP_FETCH_PIPELINING).toBe(1);
  });

  test("keeps a pool wide enough for a fan-out, and idle sockets for less than the inactivity bound", () => {
    expect(STEP_FETCH_CONNECTIONS).toBeGreaterThanOrEqual(32);
    expect(STEP_FETCH_KEEP_ALIVE_MS).toBeLessThan(STEP_FETCH_INACTIVITY_MS);
  });
});
