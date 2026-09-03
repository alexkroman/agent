// Copyright 2025 the AAI authors. MIT license.

import { requestQuery } from "./request-url.ts";

/**
 * Shape a resumable session id must have to be honored.
 *
 * Every id a client can legitimately present was minted by the server as a
 * UUIDv4 and handed back in the `config` frame, so this is deliberately
 * narrow. It is a validation boundary, not a formatting preference: the id
 * becomes the key of the runtime's live-session and `ctx.state` maps, and
 * presenting it is what claims (and evicts) that session — so it is
 * attacker-reachable input on a PUBLIC, auth-free endpoint.
 *
 * Unvalidated, the guest accepted any id the HTTP request line could carry:
 * measured, a 16 000-character key was taken verbatim and echoed back, as
 * were path-traversal and NUL-escaped strings. Nothing downstream
 * interpreted them as paths, but a client-chosen, unbounded map key retained
 * across the resume grace window is not something to leave to downstream
 * luck.
 */
const RESUME_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Parse WebSocket upgrade query params into session start options.
 *
 * @internal
 */
export function parseWsUpgradeParams(rawUrl: string): {
  resumeFrom?: string;
  skipGreeting: boolean;
} {
  const params = requestQuery(rawUrl);
  // Treat an empty `?sessionId=` as absent: a defined-but-empty id is not a
  // resumable session, and it would also silently suppress the greeting.
  const raw = params.get("sessionId") || undefined;
  // An unusable id degrades to "no resume" rather than failing the upgrade:
  // it cannot name a session that exists, so the honest answer is a fresh
  // one, and rejecting the socket would turn a stale bookmark into a dead
  // page. `skipGreeting` follows the RESOLVED id — a client that is not
  // actually resuming should still be greeted.
  const resumeFrom = raw !== undefined && RESUME_ID_RE.test(raw) ? raw : undefined;
  const skipGreeting = resumeFrom !== undefined || params.has("resume");
  return resumeFrom !== undefined ? { resumeFrom, skipGreeting } : { skipGreeting };
}
