// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring template: `aai-runtime:server` epoch 1.
 *
 * The three doors a self-hosted deployment picks between, and the credential
 * fallback that lets a container pass a provider key without it becoming
 * `ctx.env` — written the way a host authored them at epoch 1. It must keep
 * compiling for as long as that epoch is advertised as supported.
 *
 * ## What moved, and why epoch 1 survives it
 *
 * Nothing this file names. `HostGenerateFn` gained an optional `onUsage` in its
 * call-options bag so `ctx.generate` reports tokens to the session's usage
 * meter, and it reaches THIS capability's report through the `RuntimeOptions`
 * rollup that {@link AgentServerOptions} carries (`agent` and `journal` are
 * both indexed off it). A host authored here never spells the type: it hands
 * `createAgentServer` an agent and an env and lets the server build the runtime.
 * An added optional field on a bag nobody names cannot break a caller, which is
 * what makes this a retain rather than a drop.
 *
 * The direction that WOULD break is a new REQUIRED member on
 * {@link AgentServer} or {@link SharedServerOptions} — but note which way each
 * of these flows. A host RECEIVES an `AgentServer` from a factory and never
 * implements one, so a member added to it is safe; it SUPPLIES the options
 * bags, so a required field arriving in one is not.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 1 has to be dropped with a reason.
 *
 * @module
 */

import type { Server } from "node:http";
import { agent } from "@alexkroman1/aai";
import {
  type AgentEnv,
  type AgentServer,
  type AgentServerOptions,
  createAgentServer,
  createHostServer,
  createRuntimeServer,
  DEFAULT_LISTEN_HOST,
  type HostCredentialEnv,
  type HostServerOptions,
  type HostSessionDefaults,
  type ProviderEnv,
  type RuntimeServerOptions,
  requiredProviderEnvVars,
  type SessionRuntime,
  type SharedServerOptions,
  withHostCredentialFallback,
} from "../../../runtime-barrel.ts";

/**
 * The agent this deployment serves.
 *
 * EDIT THIS. Everything below is wiring; this is the agent.
 */
const orders = agent({
  name: "Orders Desk",
  systemPrompt: "Look an order up before you say anything about it.",
  greeting: "Orders desk — what can I look up for you?",
  maxSteps: 4,
});

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
 * {@link HostCredentialEnv} is MINTED here and nowhere else, {@link AgentEnv}
 * refuses the brand, and {@link ProviderEnv} accepts either. So a host-fallback
 * env can reach a provider opener and can never be handed to tool code as
 * `ctx.env` — which is a compile error rather than a review comment.
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
 * from the agent, which is why it is the door to take unless something below is
 * specifically needed.
 */
export async function serveOneAgent(port: number): Promise<AgentServer> {
  const options: AgentServerOptions = { ...shared, agent: orders, env: agentEnv, providerEnv };
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
 * {@link SessionRuntime} (its own provider wiring, its own tool executor) and
 * wants the HTTP and WebSocket surface over it. Takes the runtime as an
 * argument rather than building one, because whose runtime it is is the whole
 * point.
 */
export async function serveExistingRuntime(
  runtime: SessionRuntime,
  port: number,
): Promise<AgentServer> {
  const options: RuntimeServerOptions = {
    ...shared,
    runtime,
    name: orders.name,
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
  const options: HostServerOptions = { ...shared, defaults, name: "host" };
  const server = createHostServer(options);
  await server.listen(port, DEFAULT_LISTEN_HOST);
  return server;
}

/**
 * ── EDIT: a platform that binds the socket itself. ──────────────────────
 *
 * A function platform reads a `node:http` server off the module and binds the
 * socket, so what it wants is the wired server rather than a call that binds
 * one. What such a host does NOT get is a WebSocket: function runtimes deliver
 * no `upgrade` event, so the voice routes are unreachable there however this is
 * mounted. The HTTP surface — `/health`, `/client-config`, `/workflows/*`, the
 * webhook route — is unaffected, which is what a static workflow page needs.
 */
export function handOff(): Server {
  return createAgentServer({ ...shared, agent: orders, env: agentEnv, providerEnv }).node;
}

/** Whichever door bound it, this is how a shutdown releases the socket. */
export async function stopServer(server: AgentServer): Promise<void> {
  await server.close();
}
