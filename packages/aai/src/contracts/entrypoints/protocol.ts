// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `protocol`.
 *
 * The session wire format — the commands a client sends, the events and ready
 * config a server answers with, and the `/client-config` handshake — that
 * `@alexkroman1/aai-ui` in a browser and `@alexkroman1/aai-runtime` in a
 * guest both derive from.
 *
 * It was deny-listed from the contract system as "not something an agent
 * declares", which was true and beside the point. The two ends of this wire
 * ship on DIFFERENT schedules: a deployed agent runs the SDK it was BUILT with,
 * pinned in its bundle, while the browser client it talks to is whatever
 * `aai-ui` the page loaded — so a field renamed here breaks sessions between a
 * new client and an old agent with no build anywhere failing. That is the
 * version-drift hazard epochs exist for, and the reference page for this
 * subpath already calls it "the published wire contract … for building custom
 * clients or servers". An author never imports it; a custom client or a
 * self-hosted server does, which is why `/protocol` is also exempt from
 * needing a template example (`UNEXEMPLIFIED_SUBPATHS`).
 *
 * `ClientConfigResponse` and its schema are absent on purpose: `/protocol` and
 * `/workflow-api` both re-export them, and `workflow-api` already owns them — a
 * name belongs to exactly one capability, or a change to it bumps two epochs.
 *
 * Re-exported from `@alexkroman1/aai/protocol`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export {
  buildClientConfig,
  buildReadyConfig,
  CLIENT_CONFIG_METHODS,
  CLIENT_CONFIG_PATH,
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
  type SessionEventMeta,
  SessionEventMetaSchema,
} from "../../sdk/protocol-barrel.ts";
