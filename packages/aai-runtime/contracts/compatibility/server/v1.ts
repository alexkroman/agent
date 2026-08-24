// Copyright 2026 the AAI authors. MIT license.
/**
 * Epoch-1 TEMPLATE for the `aai-runtime:server` capability — the self-hosted
 * bootstrap as it was written at epoch 1. Copy the file into your own host,
 * edit the lines marked `←`, and leave the rest alone.
 *
 * **Restored, and it is a promise now.** This file was deleted when the epoch
 * history was reset (nothing had shipped for it to be compatible WITH, so the
 * current epoch owes no example). epoch 2 moved because this capability's rollup MENTIONS `RuntimeOptions`, which grew three optional fields — no name on this door changed, which supersedes epoch 1 while keeping
 * it supported — so this is the evidence that a host written against epoch 1
 * still compiles. It was recovered verbatim and needed no edit, which is itself
 * the finding: the change was additive.
 *
 * FROZEN. It must keep compiling for as long as epoch 1 is supported, so do not
 * edit it to follow a change in this package's API: a compile error here is the
 * finding, not a chore. Changing the API means a NEW epoch with a new template
 * beside this one — never an edit to this file.
 *
 * The typed sibling of `packages/aai-templates/scaffold/server.mjs`, which is
 * the same bootstrap in JavaScript with its filesystem work spelled out. Order
 * of operations, which is the order a deployment does things in:
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
 * bundler is the only thing that can turn that directory into imports. Loading
 * `agent.ts` directly serves an agent with no tools.
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
 * container supplies them with `-e`. Listing them rather than forwarding all of
 * `process.env` is deliberate: an agent that can read `PATH` or `HOME` comes to
 * depend on a variable that will not exist wherever you deploy it next.
 *
 * Provider credentials do NOT belong here. They arrive through
 * {@link providerCredentials} below, which keeps them out of `ctx.env`.
 */
const DECLARED_ENV_KEYS: readonly string[] = ["BOOKINGS_API_TOKEN"];

/** ← the port and interface this process binds, if not `PORT` / `HOST`. */
const DEFAULT_PORT = 3000;

/**
 * The agent's env, read out of the process environment.
 *
 * An empty value is dropped rather than passed through: a provider handed `""`
 * tries to authenticate with it and reports a puzzling auth failure, where an
 * absent key is reported as absent.
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
 * `ctx.env`.
 *
 * This is the ordinary way a container hands over `ASSEMBLYAI_API_KEY`: copying
 * it into {@link agentEnv} would work and would also publish it to your own
 * tool code. Do not "simplify" the two calls into one — the returned brand is
 * accepted by `providerEnv` and REFUSED by `env`, so the separation is a
 * compile error rather than a review comment.
 */
export function providerCredentials(env: AgentEnv): HostCredentialEnv {
  return withHostCredentialFallback(env);
}

/**
 * The startup preflight: which credential names this agent's declared providers
 * will try to resolve, and which of them are missing.
 *
 * Worth doing before `listen`, because the alternative is discovering it inside
 * the first session — where a missing key reaches the caller as an opaque
 * provider auth error several seconds into a call.
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
 * So set it only when you know it.
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
    ...(clientDir ? { clientDir } : {}),
    ...(publicUrl ? { publicUrl } : {}),
    // Forwarded one field at a time, NOT spread. These fields are optional
    // without `| undefined`, and a spread widens each to `T | undefined`, which
    // the options type refuses under `exactOptionalPropertyTypes` (TS2379).
    ...(hooks.logger ? { logger: hooks.logger } : {}),
    ...(hooks.upgrade ? { upgrade: hooks.upgrade } : {}),
    ...(hooks.request ? { request: hooks.request } : {}),
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
