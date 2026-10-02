// Copyright 2026 the AAI authors. MIT license.
/** The shared ready/reason verdict an eval suite skips on. */

import { describe, expect, test } from "vitest";
import { credentialVerdict } from "./_credential-verdict.ts";

describe("credentialVerdict", () => {
  test("nothing missing is ready, with no reason", () => {
    expect(credentialVerdict([])).toEqual({ missing: [], ready: true, reason: undefined });
  });

  test("one missing name is singular and names the fix", () => {
    const verdict = credentialVerdict(["ASSEMBLYAI_API_KEY"]);
    expect(verdict.ready).toBe(false);
    expect(verdict.reason).toBe(
      "ASSEMBLYAI_API_KEY is not set — export it, or put it in the project's .env and run `aai eval`",
    );
  });

  test("several missing names are listed and plural", () => {
    const verdict = credentialVerdict(["A_KEY", "B_KEY"]);
    expect(verdict.missing).toEqual(["A_KEY", "B_KEY"]);
    expect(verdict.reason).toMatch(/^A_KEY, B_KEY are not set — /);
  });
});
