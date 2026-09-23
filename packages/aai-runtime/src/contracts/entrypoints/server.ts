// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `server`.
 *
 * Serving an agent over HTTP and a WebSocket: the three entry points a
 * self-hosted deployment picks between, and the credential fallback that lets a
 * container pass a provider key without it becoming `ctx.env` — and who may
 * open a session on one (the session ticket and `auth`).
 *
 * Re-exported from `@alexkroman1/aai-runtime`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export {
  type AgentEnv,
  type AgentServer,
  type AgentServerOptions,
  createAgentServer,
  createHostServer,
  createRuntimeServer,
  createSessionToken,
  DEFAULT_LISTEN_HOST,
  type HostCredentialEnv,
  type HostServerOptions,
  type HostSessionDefaults,
  type ProviderEnv,
  type RuntimeServerOptions,
  requiredProviderEnvVars,
  SESSION_AUTH_PROTOCOL_PREFIX,
  SESSION_SECRET_ENV,
  SESSION_UNAUTHORIZED_CLOSE_CODE,
  type SessionAuthOptions,
  type SessionIdentity,
  type SessionTokenInput,
  type SessionVerifier,
  type SharedServerOptions,
  type VerifySessionTokenOptions,
  verifySessionToken,
  withHostCredentialFallback,
} from "../../runtime-barrel.ts";
