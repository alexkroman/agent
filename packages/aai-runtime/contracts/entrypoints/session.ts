// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `session`.
 *
 * One live session as the transport layer sees it: the core, the socket it
 * bridges, and the event stream a caller reads back.
 *
 * Re-exported from `@alexkroman1/aai-runtime`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export type {
  SessionCore,
  SessionEventPage,
  SessionEventStream,
  SessionWebSocket,
  StateSyncSession,
  StoredSessionEvent,
  TransportEventBody,
  TransportEventType,
} from "../../runtime-barrel.ts";
export { SESSION_EVENTS_TOKEN_ENV } from "../../runtime-barrel.ts";
