// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:server` epoch 16.
 *
 * A host serving an agent the way it was authored at epoch 16 — build the
 * server, then BIND it through `listen()`, which was the only door in. It must
 * keep compiling for as long as that epoch is advertised as supported.
 *
 * ## What moved, and why epoch 16 survives it
 *
 * Epoch 17 added `AgentServer.node`, the wired-but-unbound `node:http` server,
 * for a host that binds the socket itself — a serverless platform that reads a
 * module's default export, or an embedder mounting onto its own server. Adding
 * a member to an interface the SDK RETURNS is not breaking: nothing below names
 * it, and a host that only ever called `listen()` is unaffected. That is what
 * makes this a retain rather than a drop.
 *
 * The direction that WOULD break is a caller IMPLEMENTING `AgentServer` — a new
 * required member is a new obligation. That is not what this capability is
 * authored against: a host receives one from `createAgentServer`, it does not
 * supply one, so the promise holds.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 16 has to be dropped with a reason.
 */

import type { AgentServer, AgentServerOptions } from "../../../runtime-barrel.ts";
import {
  createAgentServer,
  DEFAULT_LISTEN_HOST,
  requiredProviderEnvVars,
  withHostCredentialFallback,
} from "../../../runtime-barrel.ts";

/** The agent env a host assembles — deliberately explicit, never `process.env`. */
const env = { ASSEMBLYAI_API_KEY: "not-a-real-key" };

/**
 * Serve one agent on a port, the epoch-16 way.
 *
 * `providerEnv` goes through `withHostCredentialFallback` so a credential may
 * arrive as an ordinary environment variable without becoming `ctx.env`, which
 * is the arrangement a container wants.
 */
export async function serveExampleAgent(port: number): Promise<AgentServer> {
  const options: AgentServerOptions = {
    agent: {
      name: "Frozen Example",
      systemPrompt: "You are helpful.",
      greeting: "Hello.",
      maxSteps: 4,
      tools: {},
    },
    env,
    providerEnv: withHostCredentialFallback(env),
  };

  const server = createAgentServer(options);
  // Loopback unless the host says otherwise — exposing it is an explicit act.
  await server.listen(port, DEFAULT_LISTEN_HOST);
  return server;
}

/**
 * What this deployment must have set before a session can start.
 *
 * Reads the PROVIDER selection rather than the whole agent — the credential a
 * deployment owes is a fact about which providers it named.
 */
export function exampleRequiredEnv(): readonly string[] {
  return requiredProviderEnvVars({
    stt: { kind: "assemblyai" },
    llm: { kind: "assemblyai" },
    tts: { kind: "assemblyai" },
  });
}

/** Shut it down — `close()` does not care which side called `listen`. */
export async function stopExampleAgent(server: AgentServer): Promise<void> {
  await server.close();
}
