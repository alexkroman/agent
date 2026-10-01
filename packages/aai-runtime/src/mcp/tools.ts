// Copyright 2026 the AAI authors. MIT license.
/**
 * The MCP servers an agent declares, turned into tools the model can call.
 *
 * {@link withMcpTools} is the whole surface: hand it an agent definition and it
 * hands back the definition to SERVE, with every reachable server's tools
 * attached as one `"mcp"` {@link Toolset} on `toolsets` — after the agent's own,
 * so composition (first wins) can never let a remote tool shadow one an author
 * wrote.
 *
 * ## An MCP tool is an ORDINARY tool, deliberately
 *
 * `@ai-sdk/mcp` returns tools in the AI SDK's own `Tool` shape, which would
 * drop straight into `streamText` — and this does not do that. `ExecuteTool` is
 * where validation, the tool context, the per-call deadline, `ctx.signal` on
 * barge-in, the `finally` that commits session state, the failure-shaped-as-a-
 * tool-result contract and the relay observer live, and a tool set handed to
 * `streamText` beside our own would have none of them. So a discovered tool
 * becomes a `ToolDef` whose `execute` calls the AI SDK tool's; one adapter
 * module is cheaper than "MCP tools behave differently from every other tool".
 *
 * ## Discovery is EAGER, and that is a consequence rather than a preference
 *
 * `createRuntime` is synchronous and takes `toolSchemas` as a snapshot array,
 * so the tool list a session advertises is fixed before the first turn. A
 * server's tools therefore have to be known before the runtime is built, which
 * is why this is a step a host takes rather than something `createAgentServer`
 * does on the author's behalf. What it costs: a server that comes up after the
 * process did contributes nothing until a restart. What it buys: no session
 * ever waits on a third party, because by the time a session exists the answer
 * is already in hand.
 *
 * ## A bad server costs its own tools and NOTHING else
 *
 * Every failure — unreachable, wedged, missing its token, refusing the
 * handshake, answering a malformed list — is caught per server, recorded as an
 * {@link McpServerStatus} with a reason, and logged. This function does not
 * reject. An agent whose `docs` server is down is an agent without
 * `mcp_docs_*`, which is a smaller loss than a voice session that will not
 * start, and the log line is what says which happened.
 *
 * A failure AFTER discovery — the server dies mid-call — is a `ToolFailure`
 * returned to the model rather than a throw, for the same reason every builtin
 * answers `{ error }`: the model can say something true about it and move on.
 *
 * ## TWO defences, against two different attacks
 *
 * - **Namespacing**, here: a tool name is `mcp_<server>_<tool>`
 *   ({@link mcpToolName}), so a third party's `transfer_funds` cannot land
 *   where the agent's own tool of that name stood.
 * - **Fingerprinting**, in `drift.ts`: a server cannot change what its OWN
 *   tool means after an author reviewed it.
 *
 * Neither substitutes for the other, and the module doc there argues its half.
 *
 * Three NAME collisions remain possible and all three are decided the same way,
 * first wins, loser dropped, drop LOGGED:
 *
 * - **against a native tool** — the agent's own file wins, always. A silent
 *   shadow is the failure this is here to prevent.
 * - **between two servers** — servers are walked in sorted key order, so the
 *   winner does not depend on the order keys were typed in or survived a JSON
 *   round trip.
 * - **within one server**, when two long remote names truncate onto one
 *   64-character name. Tools are walked in sorted name order for the same
 *   reason.
 *
 * The one collision NOT decided here is against a BUILTIN (`web_search`,
 * `run_code`, …). None of those carries the `mcp_` prefix so it is unreachable
 * today, and if it ever were, `mergeBuiltinSurface` already resolves it the
 * same way — the provided tool wins and the drop is logged.
 */

import type { McpServerConfig, McpServers, ToolDef, Toolset } from "@alexkroman1/aai";
import { mcpToolName } from "@alexkroman1/aai";
import { agentToolsets, type ToolBearingDef, toolset } from "@alexkroman1/aai/manifest";
import { errorMessage } from "@alexkroman1/aai/utils";
import pTimeout from "p-timeout";
import type { Logger } from "../runtime-config.ts";
import { type DiscoveredTool, discover, mcpTool } from "./adapt.ts";
import {
  MCP_CONNECT_TIMEOUT_MS,
  type McpConnectOptions,
  type McpSession,
  type McpSessionOpener,
  openMcpSession,
} from "./connect.ts";
import { assessTools, driftMessages, type McpDrift, type McpTrust } from "./drift.ts";
import { allowTools, displayUrl, resolveServer } from "./resolve.ts";

/** What one declared server ended up contributing, and why when the answer is nothing. */
export type McpServerStatus = {
  /** The author's key for the server. */
  key: string;
  /**
   * The endpoint: as declared when it is a literal, and only its ORIGIN when a
   * resolver computed it (a per-user URL is not a log line's business). Never
   * the token, never a header.
   */
  url: string;
  /** The tool names it contributed, after namespacing and collision resolution. */
  tools: readonly string[];
  /**
   * Every discovered tool's fingerprint, by REMOTE name — what to copy into
   * `mcpServers.<key>.pinnedTools` once a human has read the tools. Empty for a
   * server that did not answer.
   */
  fingerprints: Readonly<Record<string, string>>;
  /** The diff against the pin, when the agent declared one. */
  drift?: McpDrift;
  /** Present exactly when the server contributed nothing, saying why. */
  unavailable?: string;
};

/**
 * What {@link withMcpTools} hands back.
 *
 * @sealed
 */
export type McpToolSurface<D> = {
  /** The definition to serve — the one passed in, plus the discovered tools. */
  agent: D;
  /** One entry per DECLARED server, in sorted key order, reachable or not. */
  servers: readonly McpServerStatus[];
  /**
   * Close every session that opened.
   *
   * Call it when the server closes. Never rejects: a session that will not
   * close cleanly is not something a shutdown can act on, and one failing must
   * not strand the rest.
   */
  close(): Promise<void>;
};

/** Options {@link withMcpTools} takes. */
export type McpToolsOptions = McpConnectOptions & {
  /**
   * The agent's environment — where a server's `tokenEnv` is read from.
   *
   * The AGENT's env, never `process.env`: on the platform every credential is
   * user-provided and this process holds none of them, so a fallback to the
   * host's environment would be a credential path that cannot exist in
   * production and silently works in development.
   */
  env?: Readonly<Partial<Record<string, string>>> | undefined;
  /** Where a dropped tool, a drifted one, an unreachable server and the summary are reported. */
  logger?: Logger | undefined;
  /**
   * How a session is opened. The test seam — pass one and no socket is opened.
   * Leave it unset in production: the default is the SSRF-screened HTTP client
   * in `connect.ts`.
   */
  openSession?: McpSessionOpener | undefined;
};

/**
 * One declared server after the connect attempt: either its live session and
 * what it publishes, or the reason it contributed nothing.
 *
 * A discriminated result rather than a throw, because the CALLER decides what a
 * dead server costs — and here the answer is always "its own tools, and nothing
 * else". The two arms are told apart by `unavailable`.
 */
type OpenedServer =
  | { key: string; url: string; unavailable: string }
  | {
      key: string;
      url: string;
      session: McpSession;
      found: readonly DiscoveredTool[];
      trust: McpTrust;
    };

/** What {@link openDeclared} needs that is not the server's own declaration. */
type OpenDeps = {
  env: Readonly<Partial<Record<string, string>>>;
  clientId: string | undefined;
  open: McpSessionOpener;
  budget: number;
  logger: Logger | undefined;
};

/**
 * Resolve, connect, list and assess one server, converting every failure into
 * the `unavailable` arm.
 *
 * The inner `try` is what stops a listing failure leaking a socket: the session
 * opened, so it has to be closed before the failure is reported.
 */
async function openDeclared(
  key: string,
  config: McpServerConfig,
  deps: OpenDeps,
): Promise<OpenedServer> {
  let url = displayUrl(config);
  try {
    // The resolvers run under the same budget as the handshake: a resolver that
    // creates a vendor session is a network round trip too, and "this server's
    // tools are unavailable" has to arrive within one budget either way.
    const signal = AbortSignal.timeout(deps.budget);
    const resolved = await pTimeout(
      resolveServer(key, config, { env: deps.env, clientId: deps.clientId, signal }),
      {
        milliseconds: deps.budget,
        message: `MCP server "${key}"'s url/headers resolvers did not finish within ${deps.budget}ms`,
      },
    );
    if ("unavailable" in resolved) return { key, url, unavailable: resolved.unavailable };
    url = displayUrl(config, resolved.server.url);
    const session = await deps.open(resolved.server);
    try {
      const listed = await pTimeout(session.tools(), {
        milliseconds: deps.budget,
        message: `MCP server "${key}" did not answer tools/list within ${deps.budget}ms`,
      });
      const tools = allowTools(key, listed, config.allowedTools, deps.logger);
      const trust = await assessTools(tools, config.pinnedTools);
      return { key, url, session, found: await discover(tools), trust };
    } catch (cause) {
      await session.close().catch(() => undefined);
      throw cause;
    }
  } catch (cause) {
    return { key, url, unavailable: errorMessage(cause) };
  }
}

/**
 * Add one connected server's tools to the registry, returning the names it got.
 *
 * `taken` is threaded rather than recomputed so a name claimed by an earlier
 * server — or by the agent's own `tools/` — is still claimed here; it is what
 * makes "first wins" true across servers as well as within one.
 */
function registerTools(
  entry: Extract<OpenedServer, { session: McpSession }>,
  taken: Set<string>,
  registry: Record<string, ToolDef>,
  logger: Logger | undefined,
): string[] {
  const names: string[] = [];
  // Sorted for the same reason the servers are: two remote names can truncate
  // onto one 64-character tool name, and which of them wins must not depend on
  // the order the server happened to list them in.
  const listed = [...entry.found].sort((a, b) => a.remote.localeCompare(b.remote));
  for (const found of listed) {
    // The drift refusal comes FIRST: a changed tool must not even be able to
    // win a name race against one the pin still trusts.
    if (entry.trust.refused.has(found.remote)) continue;
    const name = mcpToolName(entry.key, found.remote);
    if (taken.has(name)) {
      logger?.warn(
        `MCP tool "${found.remote}" from server "${entry.key}" is not offered: the name "${name}" is already taken. A tool the agent declares always wins; rename the agent's tool, or the server's key, to offer both.`,
      );
      continue;
    }
    taken.add(name);
    registry[name] = mcpTool(found, entry.key, name);
    names.push(name);
  }
  return names;
}

/** Record one connected server's outcome and register what it may offer. */
function acceptServer(
  entry: Extract<OpenedServer, { session: McpSession }>,
  taken: Set<string>,
  registry: Record<string, ToolDef>,
  logger: Logger | undefined,
): McpServerStatus {
  for (const line of driftMessages(entry.key, entry.trust)) logger?.warn(line);
  const names = registerTools(entry, taken, registry, logger);
  logger?.info(
    `MCP server "${entry.key}" contributed ${names.length} tool${names.length === 1 ? "" : "s"}: ${names.join(", ") || "(none)"}`,
  );
  const status: McpServerStatus = {
    key: entry.key,
    url: entry.url,
    tools: names,
    fingerprints: entry.trust.fingerprints,
  };
  if (entry.trust.drift) status.drift = entry.trust.drift;
  return status;
}

/**
 * Connect every server the agent declares and attach what they publish.
 *
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { createAgentServer, withMcpTools } from "@alexkroman1/aai-runtime";
 *
 * const env = { ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY ?? "" };
 * const mcp = await withMcpTools(agent({ name: "Support" }), { env });
 * const server = createAgentServer({ agent: mcp.agent, env });
 * await server.listen(3000);
 * ```
 *
 * Never rejects — read {@link McpToolSurface.servers} for what happened,
 * including the fingerprints to pin. A server that is down, refused by the SSRF
 * screen, or missing its `tokenEnv` costs its own tools and nothing else.
 *
 * **A name a server cannot have does not fail the call either.** `taken` is
 * seeded from every toolset the agent already carries (its files, its roster)
 * before any server is registered, so a remote tool whose prefixed name the
 * agent already declares is dropped by `registerTools` with a warning naming
 * both, and the agent's own tool wins.
 *
 * @public
 */
export async function withMcpTools<
  D extends ToolBearingDef & { readonly mcpServers?: McpServers | undefined },
>(def: D, options: McpToolsOptions = {}): Promise<McpToolSurface<D>> {
  const declared = def.mcpServers ?? {};
  if (Object.keys(declared).length === 0) {
    return { agent: def, servers: [], close: async () => undefined };
  }
  const taken = new Set(agentToolsets(def).flatMap((set) => Object.keys(set.list())));
  // No `clientId`: nobody is calling yet. A server whose resolvers need one
  // throws, and costs its own tools here and nothing else.
  const connected = await connectMcpServers(declared, { ...options, taken });
  const mcp: Toolset = toolset("mcp", connected.tools);
  return {
    agent: { ...def, toolsets: [...(def.toolsets ?? []), mcp] },
    servers: connected.servers,
    close: connected.close,
  };
}

/**
 * What {@link connectMcpServers} hands back: the tools every reachable server
 * contributed, one status per declared server, and the one close.
 *
 * @internal
 */
export type McpConnection = {
  /** Namespaced tool name → `ToolDef`, collisions already resolved. */
  tools: Record<string, ToolDef>;
  /** One entry per DECLARED server, in sorted key order, reachable or not. */
  servers: McpServerStatus[];
  /** Close every session that opened. Never rejects. */
  close(): Promise<void>;
};

/**
 * Connect a set of declared servers for ONE caller and adapt what they publish
 * — the core both {@link withMcpTools} (host start, no client) and the step
 * runner behind `stepMcp` (one client per call) are built on, so a server
 * behaves identically whichever of them reached it.
 *
 * Never rejects; an unreachable server is a status with `unavailable`.
 *
 * @internal
 */
export async function connectMcpServers(
  declared: McpServers,
  options: McpToolsOptions & {
    /** Names already claimed — the agent's own tools, so a server cannot shadow one. */
    taken?: Set<string> | undefined;
    /** The client this connection acts for, handed to every resolver. */
    clientId?: string | undefined;
  } = {},
): Promise<McpConnection> {
  // Sorted, so which server wins a collision does not depend on the order the
  // keys were typed in — or on the order a JSON round trip preserved them in.
  const keys = Object.keys(declared).sort();
  const logger = options.logger;
  const deps: OpenDeps = {
    env: options.env ?? {},
    clientId: options.clientId,
    open: options.openSession ?? ((server) => openMcpSession(server, options)),
    budget: options.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS,
    logger,
  };

  const sessions: McpSession[] = [];
  const registry: Record<string, ToolDef> = {};
  const taken = options.taken ?? new Set<string>();
  const statuses: McpServerStatus[] = [];

  // Connected concurrently — a second slow server must not be charged the first
  // one's budget — and awaited as a batch, because the winner of a collision has
  // to be decided in one deterministic order rather than in arrival order.
  const opened = await Promise.all(
    keys.map(async (key): Promise<OpenedServer> => {
      // `keys` came from `declared`, so this cannot miss; the fallback is what
      // `noUncheckedIndexedAccess` asks for rather than a case to handle.
      const config = declared[key] ?? { url: "" };
      return await openDeclared(key, config, deps);
    }),
  );

  for (const entry of opened) {
    if ("unavailable" in entry) {
      logger?.warn(
        `MCP server "${entry.key}" is unavailable, so its tools are not offered this run: ${entry.unavailable}`,
      );
      statuses.push({
        key: entry.key,
        url: entry.url,
        tools: [],
        fingerprints: {},
        unavailable: entry.unavailable,
      });
      continue;
    }
    sessions.push(entry.session);
    statuses.push(acceptServer(entry, taken, registry, logger));
  }

  return {
    tools: registry,
    servers: statuses,
    close: async () => {
      // `allSettled`, and each close already swallows: one server refusing to
      // close must not strand the others, and neither failure is actionable in
      // a shutdown.
      await Promise.allSettled(sessions.map((session) => session.close()));
    },
  };
}
