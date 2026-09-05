// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring template: `aai-runtime:server` epoch 17.
 *
 * The two ways a host gets a bound socket, written the way they were authored at
 * epoch 17 — `listen()` for a long-lived process, and `AgentServer.node` for a
 * platform that binds the socket itself. It must keep compiling for as long as
 * that epoch is advertised as supported.
 *
 * ## What moved, and why epoch 17 survives it
 *
 * Nothing this file names. Epoch 18 records a RELEASE TAG change and no
 * signature: `HostGenerateFn` — reachable from this capability's report through
 * the `RuntimeOptions` rollup `AgentServerOptions` carries — lost its
 * `@internal` tag when `@alexkroman1/aai-runtime/eval` began publishing a field
 * of that type. A type going from unnameable to nameable adds an import path
 * and removes none, so a host authored here is unaffected. That is what makes
 * this a retain rather than a drop.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 17 has to be dropped with a reason.
 */

import type { Server } from "node:http";
import type { AgentDef } from "@alexkroman1/aai";
import {
  type AgentServer,
  type AgentServerOptions,
  createAgentServer,
  DEFAULT_LISTEN_HOST,
} from "../../../runtime-barrel.ts";

/**
 * The agent this deployment serves.
 *
 * EDIT THIS. Everything below is wiring; this is the agent.
 */
const agent: AgentDef = {
  name: "Frozen Example",
  systemPrompt: "You are helpful.",
  greeting: "Hello.",
  maxSteps: 4,
  tools: {},
};

/**
 * ── EDIT: what this deployment supplies the door. ───────────────────────
 *
 * `env` is the agent's own environment — provider credentials, the workflow API
 * token, `DATABASE_URL`. It is forwarded to the server underneath, so a token
 * set here really does close `/workflows/*` and a database set here really is
 * where an upload's record lands.
 */
const OPTIONS: AgentServerOptions = {
  agent,
  env: { ASSEMBLYAI_API_KEY: "not-a-real-key" },
};

/** The server. Fully wired, and deliberately not listening yet. */
export function serverFor(options: AgentServerOptions = OPTIONS): AgentServer {
  return createAgentServer(options);
}

/**
 * ── EDIT: a long-lived process. ─────────────────────────────────────────
 *
 * `listen()` is the door for something that owns its own lifecycle — an
 * `npm start`, a container. `host` defaults to loopback, so exposing the server
 * on other interfaces is a decision written down rather than a default.
 */
export async function serve(
  port: number,
  host: string = DEFAULT_LISTEN_HOST,
): Promise<AgentServer> {
  const server = serverFor();
  await server.listen(port, host);
  return server;
}

/**
 * ── EDIT: a serverless host. ────────────────────────────────────────────
 *
 * A function platform reads a `node:http` server off the module and binds the
 * socket itself, so what it wants is the wired server rather than a call that
 * binds one. `port` still answers correctly afterwards, because it is asked of
 * this object rather than latched by our own `listen()`.
 *
 * What such a host does NOT get is a WebSocket: function runtimes deliver no
 * `upgrade` event, so the voice routes are unreachable there however this is
 * mounted. The HTTP surface — `/health`, `/client-config`, `/workflows/*`, the
 * webhook route — is unaffected, which is what a static workflow page needs.
 */
export function handOff(): Server {
  return serverFor().node;
}

/** Whichever door bound it, this is how a shutdown releases the socket. */
export async function stop(server: AgentServer): Promise<void> {
  await server.close();
}
