// Copyright 2026 the AAI authors. MIT license.
/**
 * The runtime object: `createRuntime` and its seams (`runtime.ts`), the types
 * it is built from and hands out (`types.ts`), and its per-session wiring — the
 * transport and providers it opens, the session's state, memory, stream and
 * controls, the keyed system prompt and the dialog/persona suffixes, the tool
 * dispatcher, `connectSession`, and the `agent({ routes })` table. Outside this
 * directory, import from here; a name not re-exported here is private to it
 * (guard-invariants rule 37).
 */

export { compileAgentRoutes, ROUTE_METHODS } from "./agent-routes.ts";
export { connectSession } from "./connect.ts";
export { createRuntime, createRuntimeWithSeams } from "./runtime.ts";
export { attachSessionStream } from "./session-stream.ts";
export type { SessionGreeting } from "./transport.ts";
export { usesAssemblyS2s } from "./transport.ts";
export type {
  AgentRuntime,
  HostRuntimeOptions,
  Runtime,
  RuntimeOptions,
  runtimeBrand,
  SessionConnection,
  SessionConnectOptions,
  SessionStartOptions,
} from "./types.ts";
