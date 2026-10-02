// Copyright 2026 the AAI authors. MIT license.
// `firstWriteWins`: retry a conditional write-then-read until a row comes back,
// a bounded number of times.

import { expect, test, vi } from "vitest";
import { firstWriteWins } from "./_claim.ts";

test("answers the first row an attempt produces", async () => {
  const attempt = vi
    .fn<() => Promise<string | undefined>>()
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce("row");
  await expect(firstWriteWins(attempt, () => "vanished")).resolves.toBe("row");
  expect(attempt).toHaveBeenCalledTimes(2);
});

test("gives up after three empty attempts with the caller's message", async () => {
  const attempt = vi.fn(async () => undefined);
  await expect(
    firstWriteWins(attempt, () => "hook tok_1 vanished between write and read"),
  ).rejects.toThrow("hook tok_1 vanished between write and read");
  expect(attempt).toHaveBeenCalledTimes(3);
});

test("a rejecting attempt is not retried", async () => {
  const attempt = vi.fn(async () => {
    throw new Error("socket reset");
  });
  await expect(firstWriteWins(attempt, () => "vanished")).rejects.toThrow("socket reset");
  expect(attempt).toHaveBeenCalledTimes(1);
});
