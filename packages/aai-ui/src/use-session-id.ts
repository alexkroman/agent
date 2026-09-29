// Copyright 2026 the AAI authors. MIT license.
/**
 * `useSessionId()` and `useClientId()` — the two ids a page keys things by, as
 * React state.
 *
 * Both read `session.identity` through the session's own subscription, so they
 * are current without any wiring. The alternative every app wrote was an
 * external store fed by `mountClient({ onSessionId })` — which is set up
 * OUTSIDE the component tree, fires only on a `config` frame (so it never says
 * "no session" after `end()`), and has to be threaded to wherever the id is
 * read. The session already knows both ids; these hooks just ask it.
 *
 * `useSyncExternalStore` over the snapshot subscription rather than a store of
 * their own: each returns a string (or `undefined`), which compares by value,
 * so a component re-renders only when ITS id changes, not on every frame the
 * session notifies for. The dialer notifies when the confirmed session id
 * changes even if no snapshot field moved with it.
 *
 * @module
 */

import { useSyncExternalStore } from "react";
import { useSessionCore } from "./context.ts";

/**
 * The server's id for the current session: `undefined` before the session's
 * first `config` frame and after `end()`; a resume or a new session updates it
 * from its own `config` frame. Key a page's history by it.
 *
 * Treat it as sensitive — whoever holds it can resume the session and read its
 * history (`VoiceSessionOptions.onSessionId` explains why).
 *
 * @example
 * ```tsx
 * import { useSessionId } from "@alexkroman1/aai-ui";
 *
 * function SessionTag() {
 *   const id = useSessionId();
 *   return <small>{id ?? "no session yet"}</small>;
 * }
 * ```
 *
 * @returns The current session id, or `undefined`.
 *
 * @public
 */
export function useSessionId(): string | undefined {
  const session = useSessionCore();
  return useSyncExternalStore(session.subscribe, session.identity.sessionId);
}

/**
 * The client id this session sends as `?client=` — the id a tool reads with
 * `sessionClientId(ctx)` and the inbox socket is held under. With
 * `mountClient({ client: "auto" })` it is this browser's `browserClientId()`;
 * `undefined` when the session sends none.
 *
 * A `client` GETTER is read when the session notifies (each snapshot change),
 * so a page that changes what its getter answers sees the new id on the next
 * render the session causes.
 *
 * @returns The client id, or `undefined`.
 *
 * @public
 */
export function useClientId(): string | undefined {
  const session = useSessionCore();
  return useSyncExternalStore(session.subscribe, session.identity.clientId);
}
