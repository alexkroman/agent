// Copyright 2025 the AAI authors. MIT license.

import { omitUndefined } from "./omit-undefined.ts";
import { requestQuery } from "./request-url.ts";
import { normalizeClientLocation } from "./session-location.ts";
import { normalizeE164 } from "./session-phone.ts";
import { CLIENT_ID_RE } from "./step-notify-client.ts";

/**
 * Shape a resumable session id must have to be honored.
 *
 * Every id a client can legitimately present was minted by the server as a
 * UUIDv4 and handed back in the `config` frame, so this is deliberately
 * narrow. It is a validation boundary, not a formatting preference: the id
 * becomes the key of the runtime's live-session and session-slot maps, and
 * presenting it is what claims (and evicts) that session — so it is
 * attacker-reachable input on a PUBLIC, auth-free endpoint.
 *
 * Unvalidated, the guest accepted any id the HTTP request line could carry:
 * measured, a 16 000-character key was taken verbatim and echoed back, as
 * were path-traversal and NUL-escaped strings. Nothing downstream
 * interpreted them as paths, but a client-chosen, unbounded map key retained
 * across the resume grace window is not something to leave to downstream
 * luck.
 *
 * Exported so a browser that is ASKED to resume a particular id (`resume(id)` on
 * `aai-ui`'s session) refuses the same ids this would silently drop.
 *
 * @internal
 */
export const RESUME_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * A client-reported phone number (`?phone=`) in E.164 form, or `undefined`.
 * An invalid one is dropped with a warning that names the parameter, never the
 * value: it is personal data, and a malformed number is still someone's.
 */
function parsePhone(raw: string | null, log?: { warn(message: string): void }): string | undefined {
  if (raw === null || raw.trim() === "") return;
  const phone = normalizeE164(raw);
  if (phone === undefined) {
    log?.warn("ws: ?phone= is not an E.164 number (+ and 8-15 digits); ignored");
  }
  return phone;
}

/**
 * Parse WebSocket upgrade query params into session start options.
 *
 * `log`, when given, hears about a `?phone=` that was dropped as invalid.
 *
 * @internal
 */
export function parseWsUpgradeParams(
  rawUrl: string,
  log?: { warn(message: string): void },
): {
  resumeFrom?: string;
  skipGreeting: boolean;
  clientLocation?: string;
  clientId?: string;
  clientPhone?: string;
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
  // Control characters stripped and an over-long one dropped — the rule
  // `sessionContext`'s `location` is held to as well (`session-location.ts`).
  const clientLocation = normalizeClientLocation(params.get("location"));
  // `?client=` names the device, so a tool can hand a run the id its `WS /inbox`
  // socket is held under (see `session-client.ts`). Unusable = absent, like the
  // session id above: it costs the device its reminders, never its session.
  // It is ALSO the key of the device's durable conversation: a connect naming
  // it is seeded with that client's history. On a server listening beyond
  // loopback the id is the ONLY credential for that history — anyone who can
  // reach the port and guess or overhear it reads what was said.
  const rawClient = params.get("client");
  const clientId = rawClient !== null && CLIENT_ID_RE.test(rawClient) ? rawClient : undefined;
  // `?phone=` is what `sessionClientPhone(ctx)` answers (see `session-phone.ts`).
  const clientPhone = parsePhone(params.get("phone"), log);
  return {
    ...omitUndefined({ resumeFrom }),
    skipGreeting,
    ...omitUndefined({ clientLocation, clientId, clientPhone }),
  };
}
