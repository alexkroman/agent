// Copyright 2026 the AAI authors. MIT license.
/**
 * Who this browser is to an agent: the id `mountClient({ client: "auto" })`
 * sends as `?client=`, the inbox HOLDER id of this tab, and the
 * `session.identity` handle both are read from.
 *
 * ## Why the SDK mints the client id
 *
 * A client id is what a tool hands a workflow run (`sessionClientId(ctx)`) so
 * the run's `stepNotifyClient` can reach this browser AFTER the session that
 * started it has closed — a reminder due tomorrow is delivered to whoever holds
 * the id tomorrow. So it must be the SAME id on the session socket and on the
 * inbox socket, and it must outlive the tab. Every app that wanted a reminder in
 * a browser wrote the same thirty lines (a `localStorage` read, a validity
 * check, a fallback for private mode) and got the second half of this module
 * wrong: see the holder below.
 *
 * - **`localStorage`, keyed by the agent's URL** (`_web-storage.ts`'s rule). Two
 *   agents served from one origin — every deployed agent, at `/:slug/` — must
 *   not share one: the id is the ONLY credential for a client's durable
 *   conversation (`VoiceSessionOptions.client`), so agent A's server, which
 *   receives it, could otherwise present it to agent B and read B's history.
 * - **Unguessable**: 128 random bits, from `crypto.getRandomValues` — which,
 *   unlike `crypto.randomUUID`, exists outside a secure context, and `aai dev`
 *   on a LAN address is plain `http:`.
 * - **Private mode** (storage throws or is absent) degrades to an id for THIS
 *   TAB, held in memory: the session and inbox still agree, a reminder set in
 *   the tab reaches the tab, and nothing outlives it.
 *
 * ## Why the holder is per TAB, not per browser
 *
 * The inbox keeps one socket per (client, holder) pair, and the same pair again
 * REPLACES the old socket — right for a device back from a Wi-Fi drop, whose old
 * socket is half-dead. Every tab of a browser shares `localStorage`, so an app
 * that used the browser-wide id as the holder had two tabs presenting the same
 * pair: each connect knocked the other tab off, the other reconnected on its
 * backoff and knocked this one off, about once a second, forever. The holder is
 * the browser id plus a suffix minted once per PAGE LOAD, so tabs coexist as
 * holders of one client and every one of them is offered the notice.
 *
 * @module
 */

import { CLIENT_ID_RE } from "@alexkroman1/aai/internal";
import { pageBaseUrl } from "./_utils.ts";
import { storageGet, storageSet, urlSlot } from "./_web-storage.ts";

const PREFIX = "aai:client:";

/** Lowercase hex of `bytes` random bytes. */
function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * This page load's suffix: minted once per JS realm, which is once per tab per
 * load. Not stored anywhere — that is the point (see the module doc).
 */
const TAB = randomHex(4);

/**
 * Ids already resolved in this realm, per storage slot. It is what makes a
 * private-mode id stable for the tab (nothing else remembers it) and saves a
 * storage read on every connection attempt otherwise.
 */
const minted = new Map<string, string>();

/**
 * This browser's stable client id for the agent at `platformUrl` —
 * `browser-<32 hex>`, minted once and kept in `localStorage`. The id
 * `mountClient({ client: "auto" })` sends; call it yourself to compose it, e.g.
 * a page joined to a speaker that sends the speaker's id instead:
 *
 * @example
 * ```ts
 * import { browserClientId, mountClient } from "@alexkroman1/aai-ui";
 *
 * declare function linkedSpeaker(): string | undefined;
 *
 * mountClient({ client: () => linkedSpeaker() ?? browserClientId() });
 * ```
 *
 * A stored value that is not a valid client id (letters, digits, `-`, `_`, at
 * most 64) is replaced. Where storage is unavailable the id lasts for this tab.
 *
 * @param platformUrl - The agent's base URL; the id is per agent. Defaults to
 *   the page's own, which is `mountClient()`'s default too.
 * @returns The id — the same one on every call for the same agent.
 *
 * @public
 */
export function browserClientId(platformUrl: string = pageBaseUrl()): string {
  const key = urlSlot(PREFIX, platformUrl);
  const known = minted.get(key);
  if (known) return known;
  const stored = storageGet("local", key);
  const id = stored && CLIENT_ID_RE.test(stored) ? stored : `browser-${randomHex(16)}`;
  if (id !== stored) storageSet("local", key, id);
  minted.set(key, id);
  return id;
}

/**
 * This TAB's inbox holder id for the agent at `platformUrl`: the browser id
 * plus a per-page-load suffix. Never the browser id alone — see the module doc
 * for the two tabs that knocked each other off once a second.
 *
 * @internal
 */
export function inboxHolderId(platformUrl: string): string {
  return `${browserClientId(platformUrl)}-${TAB}`;
}

/**
 * Who a session is to its agent — `session.identity`. Everything here is read
 * NOW (a getter `client` can change between attempts), and nothing is a
 * subscription: `useClientId()` and `useSessionId()` are the reactive reads.
 *
 * @sealed Only `createBrowserSession` produces one.
 *
 * @public
 */
export type SessionIdentity = {
  /** The agent's base URL the session dials — `VoiceSessionOptions.platformUrl`. */
  readonly platformUrl: string;
  /**
   * The client id the next connection attempt sends as `?client=`, trimmed, or
   * `undefined` when it sends none. With `client: "auto"` it is
   * {@link browserClientId}; with a getter it is the getter's answer now.
   */
  clientId(): string | undefined;
  /**
   * This tab's `?holder=` for the client's `WS /inbox` socket — per TAB, so two
   * tabs of one browser coexist instead of replacing each other's socket.
   */
  holderId(): string;
  /**
   * The server's id for the current session: `undefined` until the first
   * `config` frame of a session, and again after `end()`. A resume or a new
   * session sets it from its own `config` frame. Sensitive — see
   * `VoiceSessionOptions.onSessionId`.
   */
  sessionId(): string | undefined;
};

/** The client option as the dialer reads it: `"auto"` resolved, everything else as given. */
export function resolveClientOption(
  client: string | (() => string | undefined) | undefined,
  platformUrl: string,
): string | (() => string | undefined) | undefined {
  return client === "auto" ? () => browserClientId(platformUrl) : client;
}

/** A string-or-getter option resolved NOW, trimmed; an empty answer is none. */
export function resolveReported(
  value: string | (() => string | undefined) | undefined,
): string | undefined {
  const trimmed = (typeof value === "function" ? value() : value)?.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Build a session's {@link SessionIdentity}. `sessionId` reads the dialer's
 * confirmed id — the dialer owns it because it is the one that sees every
 * `config` frame, `end()` and `resume()`.
 */
export function createSessionIdentity(
  options: { platformUrl: string; client?: string | (() => string | undefined) | undefined },
  sessionId: () => string | undefined,
): SessionIdentity {
  const client = resolveClientOption(options.client, options.platformUrl);
  return Object.freeze({
    platformUrl: options.platformUrl,
    clientId: () => resolveReported(client),
    holderId: () => inboxHolderId(options.platformUrl),
    sessionId,
  });
}
