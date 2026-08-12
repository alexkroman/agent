// Copyright 2026 the AAI authors. MIT license.
/**
 * Serve one agent — the front door over `createRuntime` + `createServer`.
 *
 * The two-layer pair underneath stays exported and unchanged: an embedder that
 * needs `runtime.startSession(ws)` inside an existing HTTP stack, or a server
 * whose runtime does not exist yet (the guest harness builds its runtime on the
 * first session, after the bundle arrives over RPC), still reaches for them
 * directly. This is for the ordinary case — you have an agent, serve it — which
 * had to say three things by hand, one of which failed silently:
 *
 * - **`name` and `greeting` were re-stated from the agent.** `SessionRuntime` is
 *   deliberately narrowed to `startSession`/`shutdown`, so `createServer` cannot
 *   see the agent and the caller passed both again. Omitting `greeting` raised
 *   nothing — `GET /client-config` just served none, and the browser client
 *   rendered no greeting. A dropped field with no failure signal is the bug
 *   class the canonical-config rule exists to prevent; here the fields come off
 *   the agent, so there is nothing to drop.
 * - **`clientDir` meant module archaeology.** Use `defaultClientDir` from
 *   `@alexkroman1/aai-ui/client-dir`.
 * - **Shutdown ordering.** `AgentServer.close()` already shuts the runtime down,
 *   so callers who also called `runtime.shutdown()` were doing it twice.
 *
 * Import via `@alexkroman1/aai/runtime`. See `examples/self-hosted-server`.
 */

import type { Db } from "../sdk/db.ts";
import type { AgentEnv, ProviderEnv } from "../sdk/env-types.ts";
import { omitUndefined } from "../sdk/omit-undefined.ts";
import { createRuntime, type RuntimeOptions } from "./runtime.ts";
import { type AgentServer, createServer, type PassthroughServerOptions } from "./server.ts";
import { WORKFLOW_API_TOKEN_ENV } from "./workflow-api.ts";

/** Configuration for {@link createAgentServer}. */
// An interface rather than an intersection: TypeDoc documents inherited
// members of an interface, and cannot resolve a `{@link X.member}` into one
// side of an `A & B` alias — which is how the `providerEnv` link below broke.
export interface AgentServerOptions extends PassthroughServerOptions {
  /**
   * The agent to serve. Its `name` and `greeting` feed `GET /client-config`.
   *
   * Typed as whatever `createRuntime` accepts rather than restating
   * `AgentDef<any>`, which would need a second `noExplicitAny` suppression for
   * the same reason the first one exists.
   */
  agent: RuntimeOptions["agent"];
  /**
   * The agent's own env — what tool code sees as `ctx.env`, and where provider
   * credentials resolve from unless {@link AgentServerOptions.providerEnv} is
   * set. Nothing falls back to the host's `process.env`: assembling this is
   * deliberate, not boilerplate.
   */
  env: AgentEnv;
  /**
   * Env used to resolve provider credentials, when they should NOT also be
   * visible to tool code as `ctx.env` — see `RuntimeOptions.providerEnv`.
   */
  providerEnv?: ProviderEnv | undefined;
  /**
   * Static client assets to serve at `/`. For the prebuilt browser client,
   * pass `defaultClientDir` from `@alexkroman1/aai-ui/client-dir`.
   */
  clientDir?: string;
  /** SQL handle exposed to tool code as `ctx.db` — see `RuntimeOptions.db`. */
  db?: Db | undefined;
}

/**
 * Create an HTTP + WebSocket server running one agent — the self-hosting entry
 * point, and the same server `aai dev` runs.
 *
 * Serves `GET /health`, `GET /client-config`, static assets when `clientDir` is
 * set, and voice sessions on `WS /websocket`. Tools declared on the agent
 * execute IN THIS PROCESS on the credentials in `env` — the opposite
 * arrangement from `createHostServer`, where callers bring their own agent and
 * run their own tools.
 *
 * {@link AgentServer.listen} binds loopback by default; pass `"0.0.0.0"` to
 * expose it deliberately (this server has no request authentication of its
 * own). {@link AgentServer.close} shuts the runtime down too.
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { createAgentServer } from "@alexkroman1/aai/runtime";
 *
 * const server = createAgentServer({
 *   agent: agent({ name: "Support" }),
 *   env: { ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY ?? "" },
 * });
 * await server.listen(3000);
 * ```
 *
 * @public
 */
export function createAgentServer(options: AgentServerOptions): AgentServer {
  const { agent, env, providerEnv, clientDir, db, logger, upgrade, request } = options;
  const runtime = createRuntime({
    agent,
    env,
    ...omitUndefined({ providerEnv, db, logger }),
  });
  return createServer({
    runtime,
    // Read off the agent rather than asked for again — see the module doc.
    name: agent.name,
    // ONLY the workflow-API token, never the whole agent env — the same
    // narrowing the guest harness applies, for the same reason. `createServer`
    // gates host mode on `env && isHostAllowed(env)`, so forwarding the agent's
    // env wholesale ENABLES `?host=1` for any agent whose env happens to set
    // `AAI_ALLOW_HOST` — letting an unauthenticated client supply its own
    // system prompt and tool schemas and run them on this operator's
    // credentials. `createAgentServer` passed no `env` at all before the
    // workflow API needed its bearer here, so one key is also exactly the
    // previous behaviour rather than a new restriction. An operator who really
    // wants host mode has `createHostServer` (or `createServer` directly).
    env: omitUndefined({ [WORKFLOW_API_TOKEN_ENV]: env[WORKFLOW_API_TOKEN_ENV] }),
    ...omitUndefined({
      greeting: agent.greeting,
      page: agent.page,
      clientDir,
      logger,
      upgrade,
      request,
    }),
  });
}
