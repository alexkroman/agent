// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `server`.
 *
 * Serving an agent over HTTP and a WebSocket: the three entry points a
 * self-hosted deployment picks between, and the credential fallback that lets a
 * container pass a provider key without it becoming `ctx.env`.
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
  createServer,
  DEFAULT_LISTEN_HOST,
  type HostCredentialEnv,
  type HostServerOptions,
  type HostSessionDefaults,
  type PassthroughServerOptions,
  type ProviderEnv,
  requiredProviderEnvVars,
  type ServerOptions,
  withHostCredentialFallback,
} from "../../runtime-barrel.ts";
