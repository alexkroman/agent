// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `session`.
 *
 * One live session as a host sees it: the socket it hands a session, and the
 * event stream it reads back (plus the bearer variable that closes that read).
 *
 * `ServerSession`, the state-sync seam and the two `TransportEvent*` types
 * left for `@alexkroman1/aai-runtime/internal`: nothing published hands out a
 * `ServerSession` (its constructor is unexported, and `Runtime.createSession`
 * was a testing seam), so a host could name the type and never hold one.
 *
 * Re-exported from `@alexkroman1/aai-runtime`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export type {
  SessionEventPage,
  SessionEventStream,
  SessionWebSocket,
} from "../../runtime-barrel.ts";
export { SESSION_EVENTS_TOKEN_ENV } from "../../runtime-barrel.ts";
