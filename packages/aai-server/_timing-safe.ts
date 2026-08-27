// Copyright 2026 the AAI authors. MIT license.
/**
 * Constant-time comparison of two strings that may differ in length.
 *
 * `node:crypto`'s `timingSafeEqual` THROWS on a length mismatch, so every caller
 * has to guard the lengths first — and every caller had written that guard
 * itself: `phone-signature.ts` as a private `equals`, `aai-guest`'s
 * `harness-auth.ts` as its own copy across a package boundary it cannot import
 * across. This is the aai-server half, spelled once.
 *
 * Comparing lengths first leaks the length of a value the CALLER already chose,
 * never anything about the expected one.
 */

import { timingSafeEqual } from "node:crypto";

/** True when `a` and `b` are equal, without a data-dependent early exit. */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf-8");
  const right = Buffer.from(b, "utf-8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
