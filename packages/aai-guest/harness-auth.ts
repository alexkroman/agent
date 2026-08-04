// Copyright 2026 the AAI authors. MIT license.
/**
 * Bearer-token auth shared by the harness's two authenticated surfaces:
 * the `/ws` control-channel upgrade (per-sandbox token) and the studio
 * chat surface (the broker-minted per-session chat token). One timing-safe
 * comparator, so a fix here cannot miss one of the gates.
 */

import { timingSafeEqual } from "node:crypto";

export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** The token from a `Bearer <token>` Authorization header, or null. */
export function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

/** True when `header` carries exactly `secret` as a Bearer token. */
export function verifyBearer(header: string | undefined, secret: string): boolean {
  const supplied = bearerToken(header);
  return supplied !== null && supplied.length > 0 && constantTimeEquals(supplied, secret);
}
