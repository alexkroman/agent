// Copyright 2026 the AAI authors. MIT license.
/**
 * Bearer-token auth shared by the harness's two authenticated surfaces:
 * the `/ws` control-channel upgrade (per-sandbox token) and the studio
 * chat surface (the broker-minted per-session chat token). One timing-safe
 * comparator, so a fix here cannot miss one of the gates.
 */

import { timingSafeEqual } from "node:crypto";
import { parseBearer } from "@alexkroman1/aai-runtime/internal";

export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * The token from a `Bearer <token>` Authorization header, or null.
 *
 * The PARSE is `parseBearer` (`@alexkroman1/aai-runtime/internal`) rather than a
 * `startsWith("Bearer ")` of its own, which is what this was — one of three
 * byte-identical copies, all matching the scheme CASE-SENSITIVELY where RFC 7235
 * §2.1 makes it case-insensitive, so a client sending `authorization: bearer
 * <token>` was refused by both gates below with a message naming an invalid token
 * rather than a capitalisation. That module's doc has the rest, including why it
 * lives one layer down rather than in `aai-server`, which neither remaining copy
 * may import.
 *
 * `null` rather than the shared helper's `""`, because a caller here asks "is
 * there a token" — `verifyBearer` below reads the distinction, and an empty
 * string is one `constantTimeEquals` away from matching an empty secret.
 */
export function bearerToken(header: string | undefined): string | null {
  const token = parseBearer(header);
  return token === "" ? null : token;
}

/** True when `header` carries exactly `secret` as a Bearer token. */
export function verifyBearer(header: string | undefined, secret: string): boolean {
  const supplied = bearerToken(header);
  return supplied !== null && supplied.length > 0 && constantTimeEquals(supplied, secret);
}
