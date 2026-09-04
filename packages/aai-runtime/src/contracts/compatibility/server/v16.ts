// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring template: `aai-runtime:server` epoch 16.
 *
 * The three doors this capability offers, written the way they were authored at
 * epoch 16 — build a server, then BIND it through `listen()`, which was the only
 * way in. It must keep compiling for as long as that epoch is advertised as
 * supported.
 *
 * ## What moved, and why epoch 16 survives it
 *
 * Epoch 17 added `AgentServer.node`, the wired-but-unbound `node:http` server,
 * for a host that binds the socket itself — a serverless platform that reads a
 * module's default export, or an embedder mounting onto its own server. Adding
 * a member to an interface the SDK RETURNS is not breaking: nothing here names
 * it, and a host that only ever called `listen()` is unaffected. That is what
 * makes this a retain rather than a drop.
 *
 * The direction that WOULD break is a caller IMPLEMENTING `AgentServer` — a new
 * required member is a new obligation. That is not what this capability is
 * authored against: a host receives one from a factory, it does not supply one,
 * so the promise holds.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 16 has to be dropped with a reason.
 */

import type { AgentDef } from "@alexkroman1/aai";
import type {
  AgentEnv,
  AgentServer,
  AgentServerOptions,
  HostCredentialEnv,
  HostServerOptions,
  HostSessionDefaults,
  ProviderEnv,
  RuntimeServerOptions,
  SessionRuntime,
  SharedServerOptions,
} from "../../../runtime-barrel.ts";
import {
  createAgentServer,
  createHostServer,
  createRuntimeServer,
  DEFAULT_LISTEN_HOST,
  requiredProviderEnvVars,
  withHostCredentialFallback,
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
 * The agent's own env — what tool code sees as `ctx.env`.
 *
 * Assembled explicitly, never `process.env`: a deployment declares what its
 * agent may read, so a key that happens to be exported in a shell cannot
 * become something the agent depends on.
 */
const agentEnv: AgentEnv = { ASSEMBLYAI_API_KEY: "not-a-real-key" };

/**
 * Credentials a provider may resolve from without becoming `ctx.env`.
 *
 * `withHostCredentialFallback` is what lets `ASSEMBLYAI_API_KEY` arrive as an
 * ordinary environment variable — the way a container supplies one — while
 * anything the agent env declares still wins.
 *
 * The three env types are one mechanism and the brand is the whole of it:
 * `HostCredentialEnv` is MINTED here and nowhere else, `AgentEnv` refuses the
 * brand, and `ProviderEnv` accepts either. So a host-fallback env can reach a
 * provider opener and can never be handed to tool code as `ctx.env` — which is
 * a compile error rather than a review comment.
 */
const hostCredentials: HostCredentialEnv = withHostCredentialFallback(agentEnv);
const providerEnv: ProviderEnv = hostCredentials;

/**
 * What every door here shares.
 *
 * A bag rather than three copies of the same three fields: spreading it is the
 * point, which is why every member accepts `undefined`.
 */
const shared: SharedServerOptions = { logger: console };

/** What this deployment must have set before a session can start. */
export function exampleRequiredEnv(): readonly string[] {
  return requiredProviderEnvVars({
    stt: { kind: "assemblyai" },
    llm: { kind: "assemblyai" },
    tts: { kind: "assemblyai" },
  });
}

/**
 * Door one: serve ONE agent. The ordinary deployment.
 *
 * `createAgentServer` derives the runtime, the name, the greeting and the page
 * from the agent, which is why it is the door to take unless something below
 * is specifically needed.
 */
export async function serveOneAgent(port: number): Promise<AgentServer> {
  const options: AgentServerOptions = {
    ...shared,
    agent,
    env: agentEnv,
    providerEnv,
  };
  const server = createAgentServer(options);
  // Loopback unless the deployment says otherwise — exposing it is an explicit
  // act, so a container passes "0.0.0.0" here rather than getting it by default.
  await server.listen(port, DEFAULT_LISTEN_HOST);
  return server;
}

/**
 * Door two: serve a runtime the caller already built.
 *
 * The embedding door — for a deployment that constructs its own
 * `SessionRuntime` (its own provider wiring, its own tool executor) and wants
 * the HTTP and WebSocket surface over it. Takes the runtime as an argument
 * rather than building one, because whose runtime it is is the whole point.
 */
export async function serveExistingRuntime(
  runtime: SessionRuntime,
  port: number,
): Promise<AgentServer> {
  const options: RuntimeServerOptions = {
    ...shared,
    runtime,
    name: agent.name,
    env: agentEnv,
  };
  const server = createRuntimeServer(options);
  await server.listen(port, DEFAULT_LISTEN_HOST);
  return server;
}

/**
 * Door three: serve agents the CALLERS supply. Multi-tenant host mode.
 *
 * Each `?host=1` connection brings its own prompt, tools and — normally — its
 * own credentials. `defaults` is operator policy that stands for every tenant;
 * it cannot carry a `systemPrompt` or `tools`, because those belong to the
 * caller.
 *
 * No `env` here on purpose: anything set there is a house account any
 * unauthenticated caller can spend.
 */
export async function serveCallerAgents(port: number): Promise<AgentServer> {
  const defaults: HostSessionDefaults = { maxSteps: 4 };
  const options: HostServerOptions = {
    ...shared,
    defaults,
    name: "host",
  };
  const server = createHostServer(options);
  await server.listen(port, DEFAULT_LISTEN_HOST);
  return server;
}

/** Shut any of them down — `close()` does not care which side called `listen`. */
export async function stopServer(server: AgentServer): Promise<void> {
  await server.close();
}
