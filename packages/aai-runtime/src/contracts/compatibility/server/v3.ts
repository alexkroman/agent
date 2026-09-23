// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring template: `aai-runtime:server` epoch 3.
 *
 * A self-hosted `createAgentServer` deployment written the way a host authored
 * it at epoch 3 — before the server could authenticate its own sessions, when
 * the only defence was binding loopback and putting something else in front.
 * `v1.ts` and `v2.ts` carry the rest of the surface; this is the one shape
 * epoch 4 touches.
 *
 * ## What moved, and why epoch 3 survives it
 *
 * Epoch 4 ADDS: the session ticket (`createSessionToken`, `verifySessionToken`
 * and their types), the constants a client needs to present one, and an
 * OPTIONAL `auth` on {@link SharedServerOptions}. Nothing an epoch-3 host
 * wrote gains an obligation — with no `auth` and no `AAI_SESSION_SECRET` in its
 * env, `WS /websocket` opens exactly as it did — which is what makes it a
 * retain rather than a drop.
 *
 * The direction that WOULD break is `auth` becoming REQUIRED, or a secret-less
 * server refusing sessions by default. Either is an obligation added to this
 * file.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 3 has to be dropped with a reason.
 *
 * @module
 */

import { agent } from "@alexkroman1/aai";
import {
  type AgentEnv,
  type AgentServer,
  type AgentServerOptions,
  createAgentServer,
  DEFAULT_LISTEN_HOST,
  type SharedServerOptions,
} from "../../../runtime-barrel.ts";

/**
 * The agent this deployment serves.
 *
 * EDIT THIS. Everything below is wiring; this is the agent.
 */
const desk = agent({
  name: "Support Desk",
  systemPrompt: "Answer from what the tools return, not from memory.",
  greeting: "Support desk.",
});

/** What tool code sees as `ctx.env`. Assembled explicitly, never `process.env`. */
const agentEnv: AgentEnv = { ASSEMBLYAI_API_KEY: "not-a-real-key" };

/** The hook bag every front door shares — a logger here, and nothing else. */
const hooks: SharedServerOptions = {
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
};

const options: AgentServerOptions = { agent: desk, env: agentEnv, ...hooks };

/** The server, loopback-bound — at epoch 3 that bind WAS the access control. */
export async function start(port = 3000): Promise<AgentServer> {
  const server = createAgentServer(options);
  await server.listen(port, DEFAULT_LISTEN_HOST);
  return server;
}
