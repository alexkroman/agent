// Copyright 2026 the AAI authors. MIT license.
/**
 * Where a session id survives a page RELOAD.
 *
 * The id is what `?sessionId=` presents on reconnect, and it is the key the
 * agent's slot state and event log live under — so a reload that cannot produce
 * it starts a brand-new session, and a UI driven by `useAgentState` comes back
 * empty even though the agent still holds the cart. The server side of the
 * reconstitution was already built (`pushStateSnapshot` force-pushes the
 * projection after hydration on every start, `state.updated` lands in
 * `agentState`); what was missing is that nothing in the browser remembered the
 * id across a reload. `onSessionId`/`resumeSessionId` let a client wire it by
 * hand and exactly one of fourteen templates did, which is the shape of a
 * default in the wrong place.
 *
 * **`sessionStorage`, deliberately, and this is the opposite call from the
 * studio's session token.** A reload and a same-tab navigation survive it; a new
 * tab and a visit tomorrow do not, which is what we want here rather than a
 * limitation: presenting a day-old id suppresses the greeting
 * (`parseWsUpgradeParams` keys that off the id's mere presence) and rejoins a
 * conversation whose context is long gone. The studio token is a credential
 * whose value is not being asked to sign out; this is a pointer into a live call.
 *
 * Keyed by the agent's own URL, so two agents served from one origin — which is
 * every deployed agent, at `/:slug/` — cannot inherit each other's session.
 *
 * Every access is guarded: storage throws outright in some contexts (Safari
 * private mode, storage blocked by policy), and a session that cannot be
 * remembered must degrade to today's behaviour rather than failing to start.
 */

const PREFIX = "aai:session:";

/** One agent's slot in storage. */
function keyFor(platformUrl: string): string {
  // Resolved against the document, so a relative `platformUrl` ("./", the
  // default-client case) and the absolute form of the same agent agree on one
  // key. Falling back to the raw string keeps a caller that passed something
  // unresolvable working rather than throwing at construction.
  try {
    return `${PREFIX}${new URL(platformUrl, globalThis.location?.href).href}`;
  } catch {
    return `${PREFIX}${platformUrl}`;
  }
}

/** The stored session id for this agent, or undefined. @internal */
export function readStoredSessionId(platformUrl: string): string | undefined {
  try {
    return globalThis.sessionStorage?.getItem(keyFor(platformUrl)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Remember this agent's session id for the next load. @internal */
export function writeStoredSessionId(platformUrl: string, sessionId: string): void {
  try {
    globalThis.sessionStorage?.setItem(keyFor(platformUrl), sessionId);
  } catch {
    // Unavailable — the id still lives in the core for this page's lifetime.
  }
}

/**
 * Forget it, so the next load is a NEW session.
 *
 * Called from `end()`, which is the clear-and-forget the "New Conversation"
 * button runs: leaving the id behind there would have the next load rejoin the
 * conversation the user just discarded, greeting suppressed.
 *
 * @internal
 */
export function clearStoredSessionId(platformUrl: string): void {
  try {
    globalThis.sessionStorage?.removeItem(keyFor(platformUrl));
  } catch {
    // Nothing was stored, or storage is gone; either way there is nothing to do.
  }
}
