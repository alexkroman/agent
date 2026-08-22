// Copyright 2026 the AAI authors. MIT license.
/**
 * Epoch-2 TEMPLATE for the `aai-runtime:server` capability — the self-hosted
 * bootstrap as it is written at epoch 2. Copy the file into your own host, edit
 * the lines marked `←`, and leave the rest alone.
 *
 * FROZEN. It must keep compiling for as long as epoch 2 is supported, so do not
 * edit it to follow a change in this package's API: a compile error here is the
 * finding, not a chore. Changing the API means a NEW epoch with a new template
 * beside this one — never an edit to this file.
 *
 * **Two things moved since epoch 1, and both are in {@link buildServer}.**
 *
 * - **The hook bag SPREADS.** At epoch 1 `PassthroughServerOptions`' fields were
 *   optional without `| undefined`, so `{ ...hooks }` widened each to
 *   `T | undefined` and `exactOptionalPropertyTypes` rejected the whole object
 *   (TS2379) — the one bag that exists to reach all three front doors could not
 *   be handed to any of them, and `v1.ts` forwards `logger`/`upgrade`/`request`
 *   one at a time to compile. That workaround still compiles and is no longer
 *   needed; a hook added to the bag now reaches this door by itself.
 * - **`telephony` and `page` are reachable.** `createAgentServer` forwards both,
 *   and `page` defaults to the agent's own declaration. At epoch 1 neither could
 *   be expressed here at all, so every server built through this door mounted
 *   `WS /phone` — see {@link buildServer}.
 *
 * Order of operations, which is the order a deployment does things in:
 *
 * 1. Collect the agent's own env — what its tool code reads as `ctx.env`.
 * 2. Refuse to start when a provider credential the agent needs is absent.
 * 3. Build the server, with your own HTTP hooks passed through.
 * 4. Bind loopback, and close the runtime when the process is signalled.
 *
 * Nothing runs on import: call {@link main} from your entrypoint.
 */

import { agent } from "@alexkroman1/aai";

import {
  type AgentEnv,
  type AgentServer,
  type AgentServerOptions,
  createAgentServer,
  DEFAULT_LISTEN_HOST,
  type HostCredentialEnv,
  type PassthroughServerOptions,
  requiredProviderEnvVars,
  withHostCredentialFallback,
} from "../../../runtime-barrel.ts";

/**
 * ← your agent.
 *
 * Declared inline here so the template is one file. In a project scaffolded by
 * the CLI this is instead the BUILT agent — `await import("./.aai/worker.mjs")`
 * — because a tool is registered by existing as a file under `tools/`, and the
 * bundler is the only thing that can turn that directory into imports.
 */
const served = agent({
  name: "Support",
  systemPrompt: "You are a support agent. Answer in one or two sentences.",
  greeting: "Support here — what can I help with?",
});

/**
 * ← the names of your agent's OWN secrets: what its tool code reads as
 * `ctx.env`.
 *
 * Names, not values — the values come from the process environment, so a
 * container supplies them with `-e`. Provider credentials do NOT belong here;
 * they arrive through {@link providerCredentials}, which keeps them out of
 * `ctx.env`.
 */
const DECLARED_ENV_KEYS: readonly string[] = ["BOOKINGS_API_TOKEN"];

/** ← the port this process binds, if not `PORT`. */
const DEFAULT_PORT = 3000;

/**
 * The agent's env, read out of the process environment. An empty value is
 * dropped rather than passed through: a provider handed `""` tries to
 * authenticate with it, where an absent key is reported as absent.
 */
export function agentEnv(source: Record<string, string | undefined> = process.env): AgentEnv {
  const env: Record<string, string> = {};
  for (const key of DECLARED_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined && value !== "") env[key] = value;
  }
  return env;
}

/**
 * Provider credentials, taken from the host environment WITHOUT becoming
 * `ctx.env`. Do not "simplify" this into {@link agentEnv} — the returned brand
 * is accepted by `providerEnv` and REFUSED by `env`, so the separation is a
 * compile error rather than a review comment.
 */
export function providerCredentials(env: AgentEnv): HostCredentialEnv {
  return withHostCredentialFallback(env);
}

/**
 * Which credential names this agent's declared providers will try to resolve,
 * and which of them are missing. Worth doing before `listen`: the alternative
 * is an opaque provider auth error several seconds into somebody's first call.
 */
export function missingCredentials(env: AgentEnv): string[] {
  const credentials = providerCredentials(env);
  return requiredProviderEnvVars(served).filter((name) => credentials[name] === undefined);
}

/**
 * ← your own HTTP and WebSocket hooks, if you have any.
 *
 * Each returns `true` when it has answered the request itself and `false` to
 * let the agent server handle it. `GET /health` is already served; this is for
 * whatever your own orchestrator dials.
 */
export function hostHooks(): PassthroughServerOptions {
  return {
    request: (_req, res, url, method) => {
      if (url !== "/readyz" || method !== "GET") return false;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return true;
    },
  };
}

/**
 * The one call that builds the server.
 *
 * `clientDir` is the directory of your built browser UI; pass `defaultClientDir()`
 * from `@alexkroman1/aai-ui/client-dir` to serve the prebuilt one, or omit it to
 * serve no static assets at all.
 *
 * `publicUrl` is where the outside world reaches THIS server — not the socket it
 * binds, which behind a proxy is a different thing. Only
 * `ctx.workflows.publicWebhookUrl()` reads it, and it throws when absent, which
 * is better than minting a `localhost` URL a third party will dial days later.
 *
 * ← **`telephony`.** `WS /phone` serves carrier media streams (Twilio, Telnyx)
 * and is ON by default for a voice agent, because it grants exactly what
 * `/websocket` beside it grants. Leave it on if you have a phone number pointed
 * at this server; set it `false` — as here — if you do not, and the route is not
 * mounted at all.
 *
 * `page` is deliberately NOT passed: it defaults to the agent's own declaration,
 * so a `page: "static"` agent gets a static front door without this file
 * repeating the fact. Pass it only to override the agent.
 */
export function buildServer(
  env: AgentEnv,
  hooks: PassthroughServerOptions,
  clientDir?: string,
  publicUrl?: string,
): AgentServer {
  const options: AgentServerOptions = {
    agent: served,
    env,
    providerEnv: providerCredentials(env),
    telephony: false, // ←
    ...(clientDir ? { clientDir } : {}),
    ...(publicUrl ? { publicUrl } : {}),
    // Spread, not forwarded field by field: every field on the bag accepts
    // `undefined` as of this epoch, which is what makes this legal — and what
    // makes a fourth hook added to it reach this call without an edit here.
    ...hooks,
  };
  return createAgentServer(options);
}

/**
 * Shut down when the process is signalled.
 *
 * `close()` shuts the runtime down too — there is no second `shutdown()` to
 * remember. The listener is SYNCHRONOUS and hands the promise off itself: an
 * `async` listener's rejection would surface as an unhandled rejection, i.e. a
 * stack trace on Ctrl-C instead of the non-zero exit a failed shutdown is.
 */
export function closeOnSignal(server: AgentServer): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      server.close().then(
        () => process.exit(0),
        (error: unknown) => {
          console.error("shutdown failed", error);
          process.exit(1);
        },
      );
    });
  }
}

/**
 * The whole bootstrap. Call it from your entrypoint.
 *
 * The bind host defaults to {@link DEFAULT_LISTEN_HOST} — loopback — because
 * this server carries no request authentication of its own, so exposing it is a
 * deliberate act by whoever sets `HOST`. An empty `HOST` means unset, not
 * "every interface"; put your own proxy or auth in front before widening it.
 */
export async function main(): Promise<AgentServer> {
  const env = agentEnv();
  const missing = missingCredentials(env);
  if (missing.length > 0) {
    throw new Error(`Missing provider credentials: ${missing.join(", ")}`);
  }
  const server = buildServer(env, hostHooks());
  const host = process.env.HOST?.trim() || DEFAULT_LISTEN_HOST;
  await server.listen(Number(process.env.PORT ?? DEFAULT_PORT), host);
  closeOnSignal(server);
  console.log(`${served.name} listening on http://${host}:${server.port}`);
  return server;
}
