// Copyright 2026 the AAI authors. MIT license.
/**
 * The one constant-time string compare the SDK's secret checks share — a
 * webhook signature (`standard-webhook.ts`) and a one-time code's hash
 * (`one-time-code.ts`). A private copy is where the early exit creeps back in.
 */

/**
 * Compare two strings without an early exit, so timing does not leak the
 * prefix matched. A length mismatch is folded into the result rather than
 * returned first.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ (i < b.length ? b.charCodeAt(i) : 0);
  }
  return diff === 0;
}
