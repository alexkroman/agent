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
 * **A field this bag does not carry is a field nobody can reach**, which is the
 * failure mode a front door has and a two-call pair does not: dropping back to
 * `createRuntime` + `createServer` to set one option means restating by hand
 * every field this function derives, i.e. re-opening the silent drop above.
 * `telephony` was the sharp instance — off by default only for a static agent,
 * and unreachable from here, so every server built through this door mounted an
 * unauthenticated `WS /phone`. Its neighbour `page` was worse: the agent
 * DECLARES it and nothing carried the declaration through. Both are here now.
 *
 * What deliberately stays out is `createServer`'s host-mode pair (`env`,
 * `hostBaseAgent`) — a server whose sessions run agents their callers supply is
 * `createHostServer`, not this — and `createRuntime`'s testing and sandbox seams
 * (`executeTool`, `toolSchemas`, `createWebSocket`, `runCode`, `fetch`), which
 * are `@internal` and belong to the platform's own harness.
 *
 * Import via `@alexkroman1/aai-runtime`. See `examples/self-hosted-server`.
 */

import type { Db } from "@alexkroman1/aai";
import type { AgentEnv, ProviderEnv } from "@alexkroman1/aai/host-internal";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { createRuntime, type RuntimeOptions } from "./runtime.ts";
import { type AgentServer, createServer, type PassthroughServerOptions } from "./server.ts";

/** Configuration for {@link createAgentServer}. */
// An interface rather than an intersection: TypeDoc documents inherited
// members of an interface, and cannot resolve a `{@link X.member}` into one
// side of an `A & B` alias — which is how the `providerEnv` link below broke.
export interface AgentServerOptions extends PassthroughServerOptions {
  /**
   * The agent to serve. Its `name` and `greeting` feed `GET /client-config`.
   *
   * Typed as whatever `createRuntime` accepts rather than restating `AgentDef`,
   * so the two cannot disagree.
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
  /**
   * Where this server is reachable from outside — see `RuntimeOptions.publicUrl`.
   * `ctx.workflows.publicWebhookUrl()` is the only reader; without it, it throws.
   *
   * Declared HERE and not on {@link PassthroughServerOptions}, although the two
   * other front doors share that bag. The bag exists so a hook added to it reaches
   * both wrappers, and this is not that shape: `createServer` builds no workflow
   * client (its runtime is handed in), and `createHostServer`'s sessions run
   * caller-supplied agents, which declare no workflows. On either it would be a
   * field that quietly does nothing.
   */
  publicUrl?: string | undefined;
  /**
   * What this server's front door IS — see `ServerOptions.page`. Defaults to
   * the agent's own `page`, so declaring `page: "static"` on the agent is
   * enough.
   *
   * Read off the agent for the same reason `name` and `greeting` are, and it is
   * the same silent drop: a `page: "static"` agent served through this door
   * still mounted `/websocket` and `/phone`, and answered `GET /client-config`
   * as a voice agent, because nothing carried the declaration through. Set it
   * here only to override what the agent says.
   */
  page?: "voice" | "static" | undefined;
  /**
   * Serve carrier media streams on `WS /phone` — see `ServerOptions.telephony`.
   * Defaults to true for a voice agent and false for a static one.
   *
   * Forwarded rather than left to the pair underneath because it is the one
   * option here that ADDS an unauthenticated surface: reaching `false` used to
   * mean abandoning this function for `createRuntime` + `createServer` and
   * restating every field it derives, which is the silent-drop bug this wrapper
   * exists to prevent.
   */
  telephony?: boolean | undefined;
  /**
   * Base URL of a PLATFORM that serves this agent's upload bytes for it — see
   * `ServerOptions.uploadBroker`. Absent, this process talks to a bucket
   * itself.
   */
  uploadBroker?: string | undefined;
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
 * import { createAgentServer } from "@alexkroman1/aai-runtime";
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
  const {
    agent,
    env,
    providerEnv,
    clientDir,
    db,
    publicUrl,
    page,
    telephony,
    uploadBroker,
    ...hooks
  } = options;
  const runtime = createRuntime({
    agent,
    env,
    ...omitUndefined({ providerEnv, db, publicUrl, logger: hooks.logger }),
  });
  return createServer({
    runtime,
    // Read off the agent rather than asked for again — see the module doc.
    // `page` joins them, and an explicit one still wins: the field is the more
    // specific statement, the same rule `telephony` follows in `createServer`.
    name: agent.name,
    ...omitUndefined({
      greeting: agent.greeting,
      page: page ?? agent.page,
      clientDir,
      telephony,
      uploadBroker,
    }),
    // The hook bag, SPREAD — legal only because every field on
    // `PassthroughServerOptions` accepts `undefined`. Naming the three by hand
    // instead is how a fourth one added to that bag reaches the other front
    // door and silently not this one.
    ...hooks,
  });
}
