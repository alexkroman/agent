// Copyright 2026 the AAI authors. MIT license.
/**
 * The browser session core's import surface for the rest of the package.
 *
 * `createBrowserSession` and the types its handle is described by are what the
 * package builds on; every other module in `session/` (the dialer, the
 * reconnecting socket, the handshake guard, the two statecharts, the message
 * handlers, the audio path's bring-up) is private to this directory. Private
 * means NOT re-exported here: guard-invariants rule 37 fails an import from
 * outside `session/` that names any module but this one.
 *
 * @module
 */

// The memoized audio-module load. Specs outside `session/` await it once so
// fake timers never have to pump a real dynamic import.
export { loadAudioModules } from "./audio-setup.ts";
export { createBrowserSession } from "./browser-session.ts";
// The snapshot a session holds before its first frame. Exported for the
// package's mock session (`_react-test-utils.ts`), which must start from it.
export { CLEARED_SESSION_STATE } from "./messages.ts";
// The inbox asks for and presents its ticket exactly as the session does.
export { resolveSessionToken, resolveSessionTokenSync, ticketCarriage } from "./ticket.ts";
export type {
  AgentCustomEvent,
  AgentStateFrame,
  BrowserSession,
  // TYPE-ONLY: the seal is a `declare const`, so there is no value to export.
  browserSessionBrand,
  SendTextOptions,
  SessionSnapshot,
  ToolCallOutcome,
  UserTurnControls,
} from "./types.ts";
