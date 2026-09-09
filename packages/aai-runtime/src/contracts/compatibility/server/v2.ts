// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring template: `aai-runtime:server` epoch 2.
 *
 * MOUNTING the agent's HTTP and WebSocket surface beside a host's own — the
 * two claim hooks, over a runtime the host built itself — written the way a
 * host authored it at epoch 2. `v1.ts` is the other half, the three front doors
 * and the credential brand; this deliberately does not repeat them, because a
 * capability with two retained epochs is allowed to split its surface between
 * them and coverage is measured over the union
 * (`api-contracts-gate.test.ts`). It must keep compiling for as long as epoch 2
 * is advertised as supported.
 *
 * ## What moved, and why epoch 2 survives it
 *
 * A TAG, with no declaration behind it — the same transition `runtime/v2.ts`
 * records, reaching this report by the same route. `StepUsage`, the parameter
 * of the `onUsage` added to `HostGenerateFn`, was `@internal` and exported by
 * no subpath; epoch 3 retags it `@public` and publishes it from
 * `@alexkroman1/aai-runtime/eval`. It is in THIS rollup only as a forgotten
 * declaration reached through the `RuntimeOptions` that
 * {@link AgentServerOptions} indexes, so what re-rendered is the comment above
 * it. No export list moved, and nothing a host here writes changed — which is
 * what makes it a retain rather than a drop.
 *
 * The direction that WOULD break is a new REQUIRED member on
 * {@link RuntimeServerOptions} or on the hooks' signatures — a host SUPPLIES
 * both, so an obligation added to either is an obligation added to this file.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 2 has to be dropped with a reason.
 *
 * @module
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { agent } from "@alexkroman1/aai";
import {
  type AgentEnv,
  type AgentServer,
  createRuntimeServer,
  DEFAULT_LISTEN_HOST,
  type RuntimeServerOptions,
  type SessionRuntime,
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

/**
 * ── EDIT: the routes this process owns. ─────────────────────────────────
 *
 * The hook takes the FIRST look at every request the server did not already
 * answer with `/health`, and returns whether it claimed it. `true` means the
 * response is the host's problem from here; `false` falls through to the
 * agent's own routes. That boolean is the whole contract — an embedder adds a
 * surface without standing up a second HTTP server, and without the agent's
 * routes moving out of its way.
 */
const claimRequest = (
  _req: IncomingMessage,
  res: ServerResponse,
  url: string,
  method: string,
): boolean => {
  if (method !== "GET" || !url.startsWith("/admin/")) return false;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ agent: desk.name }));
  return true;
};

/**
 * ── EDIT: the upgrades this process owns. ───────────────────────────────
 *
 * The same shape one layer down: claim the socket and the server leaves it
 * alone, or decline and `/websocket` gets it. A control channel of the host's
 * own is the case this exists for — declining is what keeps the agent's voice
 * session reachable on the same port.
 */
const claimUpgrade = (req: IncomingMessage, _socket: Duplex, _head: Buffer): boolean =>
  req.url?.startsWith("/admin/socket") === true;

/**
 * What every door here shares, spread rather than restated.
 *
 * Every member accepts `undefined` on both sides, which is what makes the
 * spread legal under `exactOptionalPropertyTypes` — and is the reason this bag
 * exists at all rather than three fields copied per wrapper.
 */
const shared: SharedServerOptions = {
  logger: console,
  request: claimRequest,
  upgrade: claimUpgrade,
};

/**
 * ── EDIT: serving a runtime this host already owns. ─────────────────────
 *
 * The embedding door. It takes the runtime as an argument rather than building
 * one, because whose runtime it is is the whole point: a deployment with its
 * own provider wiring, its own tool executor or its own `generate` hands that
 * one over and gets the transport around it.
 */
export function mount(runtime: SessionRuntime): AgentServer {
  const options: RuntimeServerOptions = {
    ...shared,
    runtime,
    name: desk.name,
    greeting: desk.greeting ?? "",
    env: agentEnv,
    page: "voice",
  };
  return createRuntimeServer(options);
}

/** Bind it. Loopback unless the deployment says otherwise. */
export async function serve(
  runtime: SessionRuntime,
  port: number,
  host: string = DEFAULT_LISTEN_HOST,
): Promise<AgentServer> {
  const server = mount(runtime);
  await server.listen(port, host);
  return server;
}

/**
 * The port a server bound, asked of the server rather than remembered.
 *
 * `listen(0)` is the case that makes this worth having: the number is not known
 * until the socket is bound, and it is `undefined` before that.
 */
export function boundPort(server: AgentServer): number | undefined {
  return server.port;
}
