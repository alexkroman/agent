// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:server` epoch 4.
 *
 * A self-hosted deployment SERVING an agent — the `createAgentServer` door plus
 * the credential fallback that lets a container pass a provider key without it
 * becoming `ctx.env`. This is the shape `scaffold/server.mjs` ships, and what a
 * host copies. Written the way it was authored at epoch 4, and it must keep
 * compiling for as long as that epoch is advertised as supported.
 *
 * ## What moved, and why epoch 4 survives it
 *
 * Epoch 5 widened `SessionRuntime`'s `Pick` to carry `deliverWorkflow`, the
 * replay engine's queue-delivery hook — what a deployed guest's platform queue
 * calls to re-walk a run whose sandbox had already exited.
 *
 * Nothing below names `SessionRuntime`, and that is not luck: this door takes an
 * agent DEFINITION and builds the runtime itself, which is the whole difference
 * between it and `createServer`. A host that had reached for the pair underneath
 * would see the widened facade, and it still compiles there too — the member is
 * optional.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 4 has to be dropped with a reason.
 */

import { agent } from "@alexkroman1/aai";
import {
  type AgentServer,
  createAgentServer,
  DEFAULT_LISTEN_HOST,
  withHostCredentialFallback,
} from "../../../runtime-barrel.ts";

/** ── EDIT: the agent this deployment serves. ────────────────────────────── */
const definition = agent({
  name: "order-desk",
  systemPrompt: "You take pizza orders. Confirm the address before finishing.",
  greeting: "Order desk, what can I get you?",
});

/**
 * ── EDIT: how this deployment reads its own configuration. ───────────────
 *
 * DECLARED keys only, which is the rule `aai dev` follows too: an agent that
 * could read any ambient variable comes to depend on one that will not exist
 * after a deploy. A real deployment parses `.env` here — `.env.example` doubles
 * as the declaration, so a container with no `.env` still works.
 */
const declared: Record<string, string> = {};

/**
 * The provider credential, which is NOT `ctx.env`.
 *
 * `withHostCredentialFallback` is what lets `docker run -e ASSEMBLYAI_API_KEY=…`
 * work while keeping that key out of what tool code can read. The type brands the
 * result so it cannot be handed to `env` by mistake.
 */
const providerEnv = withHostCredentialFallback(declared);

/** ── EDIT: the port and interface. ─────────────────────────────────────── */
const PORT = Number(process.env.PORT ?? 3000);

/**
 * One call, and it is the whole self-hosted deployment.
 *
 * This door reads `page`, `name` and `greeting` off the agent and forwards the
 * options only it can — `telephony`, `env`, `uploadBroker` — which is why it
 * exists rather than being a two-line convenience over the pair underneath: an
 * option it does not carry is unreachable without restating by hand every field
 * it derives.
 */
const server: AgentServer = createAgentServer({
  agent: definition,
  env: declared,
  providerEnv,
  // Absent, `publicWebhookUrl` throws rather than minting a `localhost` URL a
  // third party cannot reach — which is the same bug with the failure moved days
  // later and onto somebody else's server.
  publicUrl: process.env.PUBLIC_URL,
});

/** Loopback by default; pass `0.0.0.0` deliberately to expose it. */
export async function start(): Promise<void> {
  await server.listen(PORT, process.env.HOST ?? DEFAULT_LISTEN_HOST);
}

export async function stop(): Promise<void> {
  await server.close();
}
