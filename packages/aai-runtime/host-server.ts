// Copyright 2026 the AAI authors. MIT license.
/**
 * Multi-tenant host server — a voice pipeline that agents are handed to at
 * connect time, rather than one that ships with an agent of its own.
 *
 * {@link createHostServer} is {@link createServer} with the three things a
 * host-only deployment always has to say said once, correctly:
 *
 * - **No agent.** A host server has nothing to serve until a tenant connects,
 *   so it takes no `agent`. `createServer` still needs a runtime for ordinary
 *   `/websocket` sessions; this supplies one that declines them, instead of
 *   making every caller hand-roll the same facade around a placeholder agent
 *   whose prompt is never read.
 * - **No env gate.** Calling this function IS the opt-in, so `AAI_ALLOW_HOST`
 *   is set for you. On `createServer` the flag guards a mode you might not
 *   know you enabled; here it would guard the only thing the server does.
 * - **No credentials required.** `env` is optional and, left empty, every
 *   session runs on the key its caller sent — so an unauthenticated tenant has
 *   no operator credential to spend, because there is none.
 *
 * Import via `@alexkroman1/aai-runtime`. See `examples/host-server`.
 */

import type { AgentDef } from "@alexkroman1/aai";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { consoleLogger } from "./runtime-config.ts";
import {
  type AgentServer,
  createServer,
  decliningRuntime,
  type PassthroughServerOptions,
} from "./server.ts";

/**
 * Session settings every tenant inherits, minus the four the handshake owns.
 *
 * The provider triple is the useful part: descriptors are plain data, so
 * declaring the pipeline here costs no credential. Everything else an
 * `AgentDef` carries — `voice`, `idleTimeoutMs`, `minBargeInWords`,
 * `builtinTools` — is operator policy and stands for every tenant.
 */
export type HostSessionDefaults = Omit<
  Partial<AgentDef>,
  "systemPrompt" | "greeting" | "tools" | "sttPrompt"
>;

/** Configuration for {@link createHostServer}. */
// An interface, not an intersection — see the note on `AgentServerOptions`.
export interface HostServerOptions extends PassthroughServerOptions {
  /**
   * What every tenant session inherits. Omit for the default all-AssemblyAI
   * pipeline — one caller-supplied `ASSEMBLYAI_API_KEY` then covers STT, the
   * LLM gateway and TTS.
   */
  defaults?: HostSessionDefaults;
  /**
   * Fallback credentials for callers that send none, keyed by env var name.
   *
   * Omit it — the multi-tenant default — and a session is only possible when
   * its caller brings a key. Anything set here is a house account that any
   * unauthenticated caller can spend, so set it deliberately; a caller's own
   * `credentials` still win over it.
   */
  env?: Record<string, string>;
  /** Display name served by `GET /client-config`. Defaults to `"host"`. */
  name?: string;
}

/** Plain `/websocket` sessions have no agent to run on a host-only server. */
const HOST_ONLY = "This server serves host-mode sessions only — connect with ?host=1.";

/**
 * Create a multi-tenant host server: an HTTP + WebSocket server whose voice
 * sessions run agents supplied by their callers.
 *
 * Each `WS /websocket?host=1` connection opens with one `config` frame
 * carrying a `host` block — `systemPrompt`, optional `greeting`, relayed tool
 * schemas, and optionally the `credentials` the session should run on. The
 * server builds a single-use runtime for that connection, relays every tool
 * call back to the caller to execute, and tears the runtime down when the
 * socket closes. No tenant code runs in this process.
 *
 * {@link AgentServer.listen} binds loopback by default. Host mode
 * authenticates the caller's provider KEY, not the caller, so it prevents key
 * theft and not abuse — put your own authentication in front (a reverse proxy,
 * or the {@link HostServerOptions.upgrade} hook) before exposing it.
 *
 * @example
 * ```ts
 * import { createHostServer } from "@alexkroman1/aai-runtime";
 *
 * const server = createHostServer();
 * await server.listen(3000);
 * ```
 *
 * @public
 */
export function createHostServer(options: HostServerOptions = {}): AgentServer {
  const { defaults, env, name = "host", logger = consoleLogger, upgrade, request } = options;
  return createServer({
    runtime: decliningRuntime(HOST_ONLY, logger),
    name,
    logger,
    // The gate goes on LAST: calling this function is the opt-in, so an
    // `AAI_ALLOW_HOST: "0"` left in a caller's env map must not disable the
    // one thing this server exists to do.
    env: { ...env, AAI_ALLOW_HOST: "1" },
    // `hostBaseAgent` only when the operator declared something. `buildHostAgent`
    // treats an absent base agent as "no provider config", which `createRuntime`
    // then fills with the default all-AssemblyAI pipeline — so omitting it is a
    // real default, not a degraded one.
    ...omitUndefined({
      hostBaseAgent: defaults && ({ name, ...defaults } as AgentDef),
      upgrade,
      request,
    }),
  });
}
