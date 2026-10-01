// Copyright 2026 the AAI authors. MIT license.
/**
 * The guest's calls to the PLATFORM: the route table and endpoint
 * (`endpoint.ts`), the multiplexed platform socket and its frame grammar
 * (`socket.ts`, `socket-frames.ts`, `socket-registry.ts`), and `platformPost`,
 * which rides the socket or falls back to `rpcFetch` (`rpc.ts`). Outside this
 * directory, import from here; a name not re-exported here is private to it
 * (`module-boundaries.test.ts`).
 */

export type { PlatformEndpoint, PlatformRoute } from "./endpoint.ts";
export {
  MAX_PLATFORM_SOCKET_FRAME_BYTES,
  PLATFORM_ROUTES,
  PLATFORM_SOCKET_PATH,
} from "./endpoint.ts";
export { platformPost, platformResult } from "./rpc.ts";
export type { PlatformSocket } from "./socket.ts";
export { createPlatformSocket, platformSocketUrl } from "./socket.ts";
export type { PlatformReplyFrame } from "./socket-frames.ts";
export { PlatformInboundFrameSchema, parsePlatformFrame } from "./socket-frames.ts";
export { closePlatformSockets, ensurePlatformSocket } from "./socket-registry.ts";
