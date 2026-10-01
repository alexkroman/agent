// Copyright 2026 the AAI authors. MIT license.
/**
 * A client's out-of-session surfaces: the `/inbox` socket and its holders
 * (`inbox.ts`), the live event feed it can carry (`event-feed.ts`, a
 * `Symbol.for` slot), and a workflow channel's outbox. Outside this directory,
 * import from here; a name not re-exported here is private to it
 * (`module-boundaries.test.ts`).
 */

export { installChannelOutbox } from "./channel-outbox.ts";
export type { ClientEventFeed } from "./event-feed.ts";
export { feedClientEvent, feedClientSessionEnd, publishClientEventFeed } from "./event-feed.ts";
export type { ClientInbox } from "./inbox.ts";
export { CLIENT_INBOX_PATH, installClientInbox } from "./inbox.ts";
