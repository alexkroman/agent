// Copyright 2026 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/protocol` — the WebSocket wire contract both ends of a session derive.
 *
 * A FACADE. The subpath resolves here rather than at `protocol.ts`, which buys two
 * things the direct form could not. That module can be SPLIT as it grows without
 * moving the published entry point — the path an implementation file happens to
 * have is not a thing to promise anyone — and a name it gains next reaches the
 * public surface only when a line is added below, rather than the moment it is
 * written.
 *
 * Named re-exports rather than `export *` for the second half of that: the
 * wildcard form re-exports whatever arrives, and needs a `noReExportAll`
 * suppression the escape-hatch ratchet only lets move down.
 *
 * @module protocol
 */

export {
  buildClientConfig,
  buildReadyConfig,
  CLIENT_CONFIG_METHODS,
  CLIENT_CONFIG_PATH,
  type ClientConfigResponse,
  ClientConfigResponseSchema,
  type ClientSink,
  EVENT_ID_PREFIX,
  type HostConfig,
  HostConfigMessageSchema,
  HostConfigSchema,
  lenientParse,
  type ReadyConfig,
  ReadyConfigSchema,
  type RestoredToolCall,
  RestoredToolCallSchema,
  SESSION_COMMAND_TYPES,
  SESSION_EVENT_TYPES,
  type SessionCommand,
  SessionCommandSchema,
  type SessionErrorCode,
  SessionErrorCodeSchema,
  type SessionEvent,
  type SessionEventBody,
  type SessionEventMeta,
  SessionEventMetaSchema,
  SessionEventSchema,
} from "./protocol.ts";
