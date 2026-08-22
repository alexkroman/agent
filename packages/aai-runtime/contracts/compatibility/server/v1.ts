// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:server` epoch 1.
 *
 * See `../../../../aai/contracts/compatibility/agent/v3.ts` for what "frozen"
 * obliges and why the imports are relative.
 *
 * **This capability's real authoring example ships to every user.**
 * `packages/aai-templates/scaffold/server.mjs` — the `npm start` entrypoint of
 * every scaffolded project — imports exactly two names from this package,
 * {@link createAgentServer} and {@link withHostCredentialFallback}, and this
 * file is that file with its JavaScript typed and its filesystem work stubbed
 * out. So the order below is the order a deployment does things in: read the
 * env, check the credentials the agent's providers will ask for, build the
 * server, bind loopback, and close it on a signal.
 *
 * The two lower doors are here because they are the ones an embedder reaches
 * for when `createAgentServer` is the wrong shape: {@link createServer} for a
 * process that already owns a runtime, and {@link createHostServer} for a
 * server with no agent of its own. Both are wrappers over the same
 * `createServer`, which is why the hook bag they pass through
 * ({@link PassthroughServerOptions}) is one type and not three.
 */

import { agent, assemblyAIPipeline } from "@alexkroman1/aai";

import {
  type AgentServer,
  type AgentServerOptions,
  createAgentServer,
  createHostServer,
  createServer,
  DEFAULT_LISTEN_HOST,
  type HostServerOptions,
  type HostSessionDefaults,
  type PassthroughServerOptions,
  requiredProviderEnvVars,
  type ServerOptions,
  withHostCredentialFallback,
} from "../../../runtime-barrel.ts";

/** The agent this process serves. One definition, served three ways below. */
const support = agent({
  name: "Support",
  systemPrompt: "You are a support agent. Answer in one or two sentences.",
  greeting: "Support here — what can I help with?",
});

/**
 * What the agent's own tool code will read as `ctx.env`.
 *
 * A plain record, and that is the whole point of the brand on
 * {@link AgentServerOptions.env}: a tenant-owned record is assignable, and the
 * `HostCredentialEnv` that {@link withHostCredentialFallback} mints is not. In
 * the scaffold this is `.env.example` merged under `.env` with real environment
 * variables winning; here the shape is what matters.
 */
const agentEnv: Record<string, string> = { SUPPORT_QUEUE_URL: "https://queue.example/support" };

/**
 * The preflight a caller can do BEFORE listening: which credential names this
 * agent's declared providers will try to resolve, and which of them are absent.
 *
 * Worth doing at startup because the alternative is discovering it inside the
 * first session, where a missing key reaches the caller as an opaque provider
 * auth error several seconds into a phone call.
 */
export function missingCredentials(env: Record<string, string>): string[] {
  const hostEnv = withHostCredentialFallback(env);
  return requiredProviderEnvVars(support).filter((name) => hostEnv[name] === undefined);
}

/**
 * The one call the scaffold makes.
 *
 * `providerEnv` is the interesting field. A container hands a provider key in as
 * an ordinary environment variable, and copying it into `env` would make it
 * `ctx.env` — readable by the agent's own tool code, which could then come to
 * depend on a variable that will not exist wherever this is deployed next.
 * `withHostCredentialFallback` copies ONLY provider-credential names, and its
 * branded result is accepted here and rejected by `env`, so the separation is a
 * compile error rather than a review comment.
 */
export function buildServer(clientDir: string, publicUrl?: string): AgentServer {
  const options: AgentServerOptions = {
    agent: support,
    env: agentEnv,
    providerEnv: withHostCredentialFallback(agentEnv),
    clientDir,
    // Only set when known: `ctx.workflows.publicWebhookUrl()` is the sole reader
    // and it throws when absent, which beats minting a `localhost` URL a payment
    // provider will dial days later.
    ...(publicUrl ? { publicUrl } : {}),
  };
  return createAgentServer(options);
}

/**
 * Binding and shutdown, which is the other half of what `server.mjs` does.
 *
 * The host defaults to {@link DEFAULT_LISTEN_HOST} rather than every interface:
 * this server carries no request authentication of its own, so exposing it is a
 * deliberate act by whoever sets `HOST`. `close()` shuts the runtime down too —
 * there is no second `runtime.shutdown()` to remember.
 */
export async function serve(server: AgentServer, port = 3000, host?: string): Promise<string> {
  await server.listen(port, host ?? DEFAULT_LISTEN_HOST);
  const url = `http://${host ?? DEFAULT_LISTEN_HOST}:${server.port}`;
  process.once("SIGTERM", () => {
    // A synchronous listener: `process` discards what a listener returns, so an
    // `async` one would surface a failed close as an unhandled rejection.
    server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
  return url;
}

/**
 * The lower door: a runtime that already exists.
 *
 * `ServerOptions["runtime"]` rather than a `SessionRuntime` import, because the
 * narrowing is the point — `createServer` is deliberately given no way to see
 * the agent, which is why `name` and `greeting` are said again here. That is
 * also the reason `createAgentServer` exists: `greeting` omitted raised nothing
 * and simply served no greeting to the browser.
 */
export function serveExistingRuntime(
  runtime: ServerOptions["runtime"],
  hooks: PassthroughServerOptions,
): AgentServer {
  return createServer({
    runtime,
    name: support.name,
    greeting: support.greeting,
    // The hooks are forwarded one at a time rather than spread: their fields are
    // declared optional WITHOUT `| undefined`, and a spread widens each to
    // `T | undefined`, which `ServerOptions` refuses under
    // `exactOptionalPropertyTypes`. Same reason `publicUrl` is guarded above.
    ...(hooks.logger ? { logger: hooks.logger } : {}),
    ...(hooks.upgrade ? { upgrade: hooks.upgrade } : {}),
    ...(hooks.request ? { request: hooks.request } : {}),
  });
}

/**
 * The other lower door: a voice pipeline agents are handed to at connect time.
 *
 * `defaults` is operator policy — everything an `AgentDef` carries EXCEPT the
 * four the handshake owns, which is what {@link HostSessionDefaults} spells.
 * Provider descriptors are plain data, so declaring the pipeline here costs no
 * credential; leaving `env` unset is what makes every session run on the key its
 * own caller sent.
 */
export function serveTenants(): AgentServer {
  const defaults: HostSessionDefaults = {
    ...assemblyAIPipeline({ voice: "jane" }),
    idleTimeoutMs: 120_000,
    maxSteps: 6,
  };
  const options: HostServerOptions = { name: "host", defaults };
  return createHostServer(options);
}
