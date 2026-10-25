// Copyright 2026 the AAI authors. MIT license.
import { expect, test } from "vitest";
import { DEFAULT_SIGNAL_HOLD_MS, SESSION_KEY } from "./workflow-options.ts";

test("SESSION_KEY is the literal `start()` and `signalRun` resolve to the session id", () => {
  expect(SESSION_KEY).toBe("session");
});

test("the default signal hold is five minutes, in milliseconds", () => {
  // Long enough for a body that transcribes or uploads before it parks, short
  // enough that a payload for a run that never parks is not held for the life
  // of the process — the constant's own doc.
  expect(DEFAULT_SIGNAL_HOLD_MS).toBe(5 * 60 * 1000);
  expect(Number.isInteger(DEFAULT_SIGNAL_HOLD_MS)).toBe(true);
});
