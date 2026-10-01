// Copyright 2026 the AAI authors. MIT license.
/**
 * The HTTP and WebSocket server: `createRuntimeServer` and its route table
 * (`server.ts`, `routes.ts`, `static.ts`), the front door `createAgentServer`
 * and its forwarding guarantee, host mode (`host-server.ts`, `host-mode.ts`,
 * `host-relay.ts`), `/api/*` over HTTP, the session ticket and auth gate, the
 * session-events API and the forwarded env (`env.ts`). Outside this directory,
 * import from here; a name not re-exported here is private to it
 * (guard-invariants rule 37).
 */

export { isPathInside } from "@alexkroman1/aai/workspace-files";
export type { AgentServerOptions } from "./agent-server.ts";
export { createAgentServer } from "./agent-server.ts";
export { agentServerEnv } from "./env.ts";
export type { HostServerOptions, HostSessionDefaults } from "./host-server.ts";
export { createHostServer } from "./host-server.ts";
export type { ServerRoute, ServerRouteMatch } from "./routes.ts";
export { SERVER_ROUTES, WORKFLOW_CALLBACK_ROUTES } from "./routes.ts";
export { createRuntimeServer, DEFAULT_LISTEN_HOST } from "./server.ts";
export type {
  SessionAuth,
  SessionAuthOptions,
  SessionVerifier,
  sessionAuthBrand,
} from "./session-auth.ts";
export {
  createSessionAuth,
  SESSION_AUTH_PROTOCOL_PREFIX,
  SESSION_SECRET_ENV,
  SESSION_UNAUTHORIZED_CLOSE_CODE,
} from "./session-auth.ts";
export { rejectingRuntime } from "./session-decline.ts";
export { SESSION_EVENTS_TOKEN_ENV } from "./session-events-api.ts";
export type {
  PlatformTicketInput,
  SessionIdentity,
  SessionTokenInput,
  VerifySessionTokenOptions,
} from "./session-ticket.ts";
export {
  createSessionToken,
  mintPlatformSessionTicket,
  PLATFORM_TICKET_RESUME_GRACE_SECONDS,
  platformSessionSecret,
  verifySessionToken,
} from "./session-ticket.ts";
export type {
  AgentServer,
  RuntimeServerOptions,
  ServerRequestHook,
  ServerUpgradeHook,
  SessionRuntime,
  SharedServerOptions,
} from "./types.ts";
