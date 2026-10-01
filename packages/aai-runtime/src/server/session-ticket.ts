// Copyright 2026 the AAI authors. MIT license.
/**
 * The session TICKET: its format, minting and checking — split out of
 * `session-auth.ts` (the gate that applies it) along the seam between "what a
 * ticket is" and "who may open a session".
 *
 * The format is `base64url(payload).base64url(HMAC-SHA256(payload))`. Three
 * minters share it: a self-hosted operator's backend ({@link createSessionToken}),
 * `aai dev` for its own client, and the managed platform's `client-config`
 * broker ({@link mintPlatformSessionTicket}), whose key is derived from the
 * guest's per-sandbox bearer ({@link platformSessionSecret}) so the guest can
 * verify it without any new credential reaching it.
 *
 * @module session-ticket
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";

/** Ticket lifetime when {@link SessionTokenInput.ttlSeconds} is omitted. */
const DEFAULT_TTL_SECONDS = 60;

/** Forward clock skew tolerated on a ticket's `iat`, in seconds. */
const CLOCK_SKEW_SECONDS = 30;

/** Longest ticket read — an HMAC ticket is ~150 bytes; this bounds the parse. */
const MAX_TOKEN_LENGTH = 4096;

/** Who a verified ticket says the caller is. */
export type SessionIdentity = {
  /** The caller's stable id — a user id, an account id. */
  sub: string;
  /**
   * The one session this ticket opens — resuming it, or starting it under this
   * id. Set it when the ticket is minted for a reconnect (a resume across a
   * server restart needs it); a bound ticket opens no other session.
   */
  sessionId?: string;
  /** Application claims carried through verification untouched. */
  claims?: Record<string, unknown>;
};

/** Input to {@link createSessionToken}. */
export type SessionTokenInput = SessionIdentity & {
  /** The same secret the server verifies with — `AAI_SESSION_SECRET`. */
  secret: string;
  /** Seconds until the ticket expires. Defaults to 60: it opens a socket, nothing more. */
  ttlSeconds?: number;
  /** Clock override for tests, in ms since the epoch. */
  now?: number;
};

type TicketPayload = {
  v: 1;
  sub: string;
  iat: number;
  exp: number;
  jti: string;
  sid?: string;
  claims?: Record<string, unknown>;
};

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function requireSecret(secret: string): void {
  if (secret.trim() === "") throw new Error("A session ticket secret must not be blank");
}

/**
 * Mint a session ticket — call this from your own backend, after your own login
 * check, and hand the result to the browser.
 *
 * ```ts
 * import { createSessionToken } from "@alexkroman1/aai-runtime/auth";
 *
 * const token = createSessionToken({
 *   secret: process.env.AAI_SESSION_SECRET ?? "",
 *   sub: "user-123", // your signed-in user's id
 * });
 * ```
 *
 * The format is `base64url(payload).base64url(HMAC-SHA256(payload))` — no JWT
 * library, and nothing a server holding the secret cannot check in one call.
 */
export function createSessionToken(input: SessionTokenInput): string {
  requireSecret(input.secret);
  if (input.sub === "") throw new Error("A session ticket needs a non-empty `sub`");
  const iat = Math.floor((input.now ?? Date.now()) / 1000);
  const payload: TicketPayload = {
    v: 1,
    sub: input.sub,
    iat,
    exp: iat + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS),
    jti: randomUUID(),
    ...omitUndefined({ sid: input.sessionId, claims: input.claims }),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, input.secret)}`;
}

/** Options for {@link verifySessionToken}. */
export type VerifySessionTokenOptions = {
  secret: string;
  /** Clock override for tests, in ms since the epoch. */
  now?: number;
};

function parsePayload(body: string): TicketPayload | undefined {
  try {
    const p: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!isRecord(p)) return undefined;
    if (p.v !== 1 || typeof p.sub !== "string" || p.sub === "") return undefined;
    if (typeof p.iat !== "number" || typeof p.exp !== "number") return undefined;
    if (p.sid !== undefined && typeof p.sid !== "string") return undefined;
    if (p.claims !== undefined && !isRecord(p.claims)) return undefined;
    return {
      v: 1,
      sub: p.sub,
      iat: p.iat,
      exp: p.exp,
      jti: typeof p.jti === "string" ? p.jti : "",
      ...omitUndefined({ sid: p.sid, claims: p.claims }),
    };
  } catch {
    return undefined;
  }
}

/**
 * Check a ticket minted by {@link createSessionToken}: the signature, then the
 * expiry. Returns the identity it carries, or `undefined` for anything else —
 * one answer for forged, expired and malformed, so a caller cannot probe which.
 */
export function verifySessionToken(
  token: string,
  options: VerifySessionTokenOptions,
): SessionIdentity | undefined {
  return checkTicket(token, options.secret, options.now, 0);
}

/**
 * The one check behind {@link verifySessionToken}: `graceSeconds` past `exp` is
 * still accepted. Only the platform broker passes a grace, and only to read a
 * PRESENTED ticket as proof it holds a session — never to admit a socket.
 */
function checkTicket(
  token: string,
  secret: string,
  nowMs: number | undefined,
  graceSeconds: number,
): SessionIdentity | undefined {
  requireSecret(secret);
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return undefined;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return undefined;
  const body = token.slice(0, dot);
  const presented = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(body, secret));
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return undefined;
  }
  const payload = parsePayload(body);
  if (payload === undefined) return undefined;
  const now = Math.floor((nowMs ?? Date.now()) / 1000);
  if (payload.exp + graceSeconds <= now || payload.iat > now + CLOCK_SKEW_SECONDS) {
    return undefined;
  }
  return {
    sub: payload.sub,
    ...omitUndefined({ sessionId: payload.sid, claims: payload.claims }),
  };
}

// ─── The managed platform's tickets ────────────────────────────────────────

/** The label the platform ticket key is derived under — rotating it rotates every key. */
const PLATFORM_TICKET_KEY_LABEL = "aai.platform-session-ticket.v1";

/**
 * How long past its expiry a platform ticket still PROVES its holder owns its
 * session, so `client-config` re-mints for that session instead of a new one.
 *
 * A browser presents the ticket it was last issued, and it is issued one per
 * connection attempt — so a call that has been up for hours presents a ticket
 * hours old when its network drops. Twelve hours bounds a stolen ticket's use as
 * a resume credential while covering any real call; the resume itself is still
 * bounded by the server's `SESSION_RESUME_GRACE_MS`.
 *
 * @internal
 */
export const PLATFORM_TICKET_RESUME_GRACE_SECONDS = 12 * 60 * 60;

/**
 * The key a deployed guest verifies platform tickets with, derived from its
 * per-sandbox bearer (`AAI_GUEST_TOKEN`, itself `guestTokenFor(sandboxName)`).
 *
 * Derived rather than delivered: the guest already holds the bearer through its
 * exec env and nothing else, so no new credential crosses into it, and none
 * reaches the agent's env or the browser. One-way: the key does not reveal the
 * bearer, so a leaked ticket key opens no `/manage/*`. Per sandbox and rotated
 * on redeploy, exactly as the bearer is.
 *
 * @internal
 */
export function platformSessionSecret(guestToken: string): string {
  requireSecret(guestToken);
  return createHmac("sha256", guestToken).update(PLATFORM_TICKET_KEY_LABEL).digest("hex");
}

/** Input to {@link mintPlatformSessionTicket}. */
export type PlatformTicketInput = {
  /** The bearer of the sandbox the ticket is for. */
  guestToken: string;
  /**
   * Bearers a PRESENTED ticket may have been signed under besides `guestToken`'s
   * — the previous deploy's, so a call survives a redeploy.
   */
  previousGuestTokens?: readonly string[];
  /** The ticket the browser presented (`SESSION_TICKET_HEADER`), if any. */
  presented?: string | undefined;
  /** Clock override for tests, in ms since the epoch. */
  now?: number;
};

/**
 * Mint the ticket `GET /:slug/client-config` hands a browser.
 *
 * What it proves is only that the holder fetched this agent's client config, a
 * minute ago. Every platform ticket is bound to ONE session (`sessionId`), and
 * that binding is the resume credential: a fresh ticket names a new session id;
 * a presented ticket, validly signed and within
 * {@link PLATFORM_TICKET_RESUME_GRACE_SECONDS} of its expiry, gets a fresh
 * ticket for the SAME session. Naming a session id without its ticket gets a
 * new session — possession, not knowledge of the id, is what resumes.
 *
 * `sub` is per session too, so the gate's "same `sub` opened it" rule can never
 * join two platform callers.
 *
 * @internal
 */
export function mintPlatformSessionTicket(input: PlatformTicketInput): string {
  const sessionId = presentedSessionId(input) ?? randomUUID();
  return createSessionToken({
    secret: platformSessionSecret(input.guestToken),
    sub: `platform:${sessionId}`,
    sessionId,
    ...omitUndefined({ now: input.now }),
  });
}

/** The session a presented platform ticket proves, if it proves one. */
function presentedSessionId(input: PlatformTicketInput): string | undefined {
  const presented = input.presented?.trim();
  if (!presented) return undefined;
  for (const token of [input.guestToken, ...(input.previousGuestTokens ?? [])]) {
    const identity = checkTicket(
      presented,
      platformSessionSecret(token),
      input.now,
      PLATFORM_TICKET_RESUME_GRACE_SECONDS,
    );
    if (identity?.sessionId !== undefined) return identity.sessionId;
  }
  return undefined;
}
