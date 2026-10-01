// Copyright 2026 the AAI authors. MIT license.
/**
 * Constant-time comparison of two strings that may differ in length.
 *
 * `node:crypto`'s `timingSafeEqual` THROWS on a length mismatch, so every caller
 * has to guard the lengths first — and every caller had written that guard
 * itself: `phone-signature.ts` as a private `equals`, `aai-guest`'s
 * `harness/auth.ts` as its own copy, `aai-runtime`'s ticket and bearer checks as
 * two more. The one copy is now the SDK's (`@alexkroman1/aai/host-internal`,
 * `host/bearer.ts`); this module keeps aai-server's importers on one local path.
 *
 * Comparing lengths first leaks the length of a value the CALLER already chose,
 * never anything about the expected one.
 */

export { constantTimeEquals } from "@alexkroman1/aai/host-internal";
