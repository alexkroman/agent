// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:server` epoch 6.
 *
 * The other two doors, and the credential types that decide which env a value
 * may land in — `createServer` for a host that already built its own runtime,
 * `createHostServer` for the studio-shaped case where the agent arrives per
 * session. `v4.ts` covers `createAgentServer`, which is the door most
 * deployments want; this is what a host copies when that one does not fit.
 * Written the way it was authored at epoch 6, and it must keep compiling for
 * as long as that epoch is advertised as supported.
 *
 * ## What moved, and why epoch 6 survives it
 *
 * Epoch 7 added an optional `journal` to `RuntimeOptions` — a host-supplied
 * durable-run journal. This capability's report moved with it and not by
 * coincidence: `AgentServerOptions.agent` is spelled `RuntimeOptions["agent"]`,
 * so the whole of that bag is rolled into this contract's surface and any
 * member added to it reaches here.
 *
 * That is worth knowing when reading a `--bump` on this capability, because
 * the delta can look like a change to a server type when it is a change to
 * the runtime's. It is still a real signature change to this surface: a host
 * reading `AgentServerOptions["agent"]` sees it.
 *
 * Adding an OPTIONAL member breaks nothing, which is what makes this a
 * retain — every bag below is still legal, and nothing here reads `journal`.
 *
 * **The direction that WOULD break is the credential BRAND.** `AgentEnv` is
 * `Record<string, string>` marked so a `HostCredentialEnv` cannot satisfy it,
 * which is the one thing in this capability enforced by the checker rather
 * than by review: tightening `ProviderEnv`, or branding `AgentEnv` so a plain
 * record no longer satisfies it, reddens every host that reads its own
 * configuration — which is all of them.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 6 has to be dropped with a reason.
 */

import { agent } from "@alexkroman1/aai";
import {
  type AgentEnv,
  type AgentServer,
  type AgentServerOptions,
  createHostServer,
  createServer,
  DEFAULT_LISTEN_HOST,
  type HostCredentialEnv,
  type HostServerOptions,
  type HostSessionDefaults,
  type PassthroughServerOptions,
  type ProviderEnv,
  requiredProviderEnvVars,
  type ServerOptions,
  type SessionRuntime,
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
 * DECLARED keys only. An agent that could read any ambient variable comes to
 * depend on one that will not exist after a deploy, so a real deployment
 * parses `.env` here and `.env.example` doubles as the declaration.
 */
const declared: AgentEnv = { GREETING_STYLE: process.env.GREETING_STYLE ?? "warm" };

/**
 * The two env types, and the whole reason they are two.
 *
 * `withHostCredentialFallback` mints a `HostCredentialEnv`: the declared keys
 * plus whatever provider credentials the SHELL has, so
 * `docker run -e ASSEMBLYAI_API_KEY=…` works. The brand on the result is what
 * stops that record ever being handed to `env` — where it would become
 * `ctx.env` and every tool in the agent could read the platform's key.
 *
 * `ProviderEnv` is the weaker claim both satisfy: fine for resolving an
 * STT/TTS/LLM credential, and it is where the fallback env is allowed to go.
 * The restriction lives on `AgentEnv`, which is the value a tenant owns.
 */
const hostEnv: HostCredentialEnv = withHostCredentialFallback(declared);
const providerEnv: ProviderEnv = hostEnv;

/**
 * Say which provider keys this agent needs BEFORE opening a socket.
 *
 * Derived from the agent's own provider triple rather than from a list a host
 * maintains: an agent that switched its TTS needs a different key, and a
 * hand-kept list is how a deployment boots green and fails on the first
 * session instead.
 */
export function missingCredentials(): string[] {
  return requiredProviderEnvVars(definition).filter((name) => !providerEnv[name]);
}

/**
 * The hooks BOTH doors share, and the reason they are their own type.
 *
 * `upgrade` and `request` return a boolean meaning "I handled it": a host
 * mounting its own health check or its own WebSocket route claims the request
 * and the agent server stops looking. Returning `true` without answering
 * hangs the client, which is why the contract is stated on the return value
 * rather than on a convention.
 */
const passthrough: PassthroughServerOptions = {
  logger: console,
  request: (_req, res, url, method) => {
    if (url !== "/healthz" || method !== "GET") return false;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return true;
  },
};

/**
 * Door one: this host built the runtime itself and wants only the server.
 *
 * `runtime` is a `SessionRuntime` — the narrow facade, not the whole runtime —
 * which is what lets a host hand over `decliningRuntime(reason)` when its own
 * boot failed halfway. Turning every session away with a reason is what stops
 * a client reconnecting against a socket that will never answer.
 *
 * Everything `createAgentServer` derives from the agent definition is stated
 * by hand here, and that is the trade: this door takes a runtime, so it cannot
 * read `page`, `name` or `greeting` off anything.
 */
export function serveExistingRuntime(runtime: SessionRuntime): AgentServer {
  const options: ServerOptions = {
    ...passthrough,
    runtime,
    name: definition.name,
    greeting: definition.greeting,
    page: definition.page ?? "voice",
    env: declared,
    telephony: false,
  };
  return createServer(options);
}

/**
 * Door two: the agent arrives per session rather than being baked in.
 *
 * This is the studio's shape — one server, many agents, each described by the
 * connecting client. `defaults` is what the host gets to decide anyway, and
 * the type says so: `systemPrompt`, `greeting`, `tools` and `sttPrompt` are
 * omitted because those are the session's to bring. What is left is policy —
 * a step ceiling, a temperature, which built-ins are on.
 */
export function serveHostMode(): AgentServer {
  const defaults: HostSessionDefaults = {
    maxSteps: 6,
    temperature: 0.4,
    builtinTools: ["think"],
  };
  const options: HostServerOptions = { ...passthrough, defaults, env: declared, name: "aai host" };
  return createHostServer(options);
}

/**
 * The bag the THIRD door takes, assembled and not passed.
 *
 * Named here because `AgentServerOptions` is what epoch 7 moved under, and a
 * host that reads it — to wrap the door, or to accept a partial from its own
 * configuration layer — is the caller that sees a change to `RuntimeOptions`
 * arrive through this capability. `v4.ts` calls the door; this is the type.
 */
export function agentServerOptions(): AgentServerOptions {
  return {
    ...passthrough,
    agent: definition,
    env: declared,
    providerEnv,
    // Absent, `publicWebhookUrl` throws rather than minting a `localhost` URL
    // a third party cannot reach — the same bug with the failure moved days
    // later and onto somebody else's server.
    publicUrl: process.env.PUBLIC_URL,
  };
}

/** ── EDIT: the port and interface. ─────────────────────────────────────── */
export async function start(server: AgentServer): Promise<void> {
  // Loopback by default; pass `0.0.0.0` deliberately to expose it.
  await server.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? DEFAULT_LISTEN_HOST);
}
