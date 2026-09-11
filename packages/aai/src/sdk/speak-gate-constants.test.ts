// Copyright 2026 the AAI authors. MIT license.
/**
 * The two speak-gate windows ship at 0, and this file is what makes flipping
 * either one a deliberate edit rather than a drive-by.
 *
 * Both are Vapi's (0.4s and 1.0s there) and neither is measured on this
 * corpus, so the shipped path has to stay byte-identical to the one the
 * tau2-bench numbers in `endpointing-constants.ts` were taken on. The
 * behavioural half of the pin is in `aai-runtime`'s
 * `pipeline-transport-options.test.ts` (the resolver) and
 * `pipeline-turn-taking.test.ts` (the transport); this is the constant itself.
 */

import { describe, expect, test } from "vitest";
import {
  DEFAULT_INTERRUPTION_BACKOFF_MS,
  DEFAULT_START_SPEAKING_FLOOR_MS,
  MAX_INTERRUPTION_BACKOFF_MS,
  MAX_START_SPEAKING_FLOOR_MS,
} from "./speak-gate-constants.ts";

describe("the shipped defaults", () => {
  test("both windows are OFF", () => {
    expect(DEFAULT_START_SPEAKING_FLOOR_MS).toBe(0);
    expect(DEFAULT_INTERRUPTION_BACKOFF_MS).toBe(0);
  });
});

describe("the caps", () => {
  test("are Vapi's own range ceiling, and above the defaults they bound", () => {
    expect(MAX_START_SPEAKING_FLOOR_MS).toBe(5000);
    expect(MAX_INTERRUPTION_BACKOFF_MS).toBe(5000);
    expect(MAX_START_SPEAKING_FLOOR_MS).toBeGreaterThan(DEFAULT_START_SPEAKING_FLOOR_MS);
    expect(MAX_INTERRUPTION_BACKOFF_MS).toBeGreaterThan(DEFAULT_INTERRUPTION_BACKOFF_MS);
  });
});
