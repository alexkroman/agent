// Copyright 2026 the AAI authors. MIT license.
/**
 * MCP tools for the studio's coding agent.
 *
 * The agent writes AAI agents from a system prompt that embeds the scaffold
 * CLAUDE.md — a snapshot. Anything not in that snapshot (a voice it hasn't
 * heard of, a gateway model added last week, a provider option) it has to
 * guess at. Connecting AssemblyAI's docs MCP server turns those guesses into
 * lookups.
 *
 * Connected per chat turn and closed when the stream settles, matching how
 * the session sandbox is handled: a studio turn is short, and a long-lived
 * shared client would be one more thing to health-check and reconnect.
 *
 * Two things keep the per-turn connect off the time-to-first-token path:
 *
 * - **The tool *listing* is cached process-wide** (per URL, short TTL). The
 *   AI SDK binds each tool's `execute` to the client it came from, so tool
 *   *objects* cannot outlive their turn's client — but the `tools/list`
 *   result can, and `client.toolsFromDefinitions()` rebuilds the objects on
 *   the fresh client without a round trip. A warm turn pays one connect, not
 *   connect + list.
 * - **Callers start `openMcpTools()` early and await it late** (see
 *   `runStudioChat`), overlapping the remaining connect latency with the
 *   turn's other awaits instead of serializing ahead of `streamText`.
 *
 * **Failure is never fatal.** A server that is down, slow, or returns
 * nonsense must not take the turn with it — the agent still has its file
 * tools and the embedded guide. Every failure path here degrades to "no MCP
 * tools this turn" and logs.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { createMCPClient, type ListToolsResult, type MCPClient } from "@ai-sdk/mcp";
import { debug } from "../_debug-log.ts";

/**
 * The SDK's own tool-set shape, taken from `client.tools()` rather than
 * `ToolSet` — MCP tools carry an inferred input schema that does not widen to
 * `ToolSet` without a cast, and casting here would hide a real mismatch.
 */
type McpTools = Awaited<ReturnType<MCPClient["tools"]>>;

/** AssemblyAI's public docs MCP server. Superseded the deprecated mcp.assemblyai.com/docs. */
export const ASSEMBLYAI_DOCS_MCP_URL = "https://www.assemblyai.com/docs/mcp";

/**
 * Tool names never exposed to the coding agent, by exact name.
 *
 * An MCP server advertises whatever it likes, including tools with
 * side effects. AssemblyAI's docs server offers `submit_feedback`, which
 * posts feedback to AssemblyAI — the studio agent has no business speaking
 * for the user, and it is not something a coding turn should ever reach for.
 * Read-only lookup is the whole reason MCP is wired up here.
 */
const DENIED_TOOLS: ReadonlySet<string> = new Set(["submit_feedback"]);

/**
 * How long to wait for the connect phase before giving up on MCP for this
 * turn. The user is watching a chat box; a slow docs server should cost them
 * a lookup, not the reply. Kept short: tool objects cannot be cached across
 * turns (their `execute` is bound to the turn's client), so a degraded server
 * charges this bound to every turn — 2s is plenty for a healthy HTTPS
 * handshake and small enough to hide inside the turn's other awaits.
 */
const CONNECT_TIMEOUT_MS = 2000;

/** How long to wait for `tools/list`. Paid only on a listing-cache miss. */
const LIST_TIMEOUT_MS = 5000;

/**
 * How long a cached `tools/list` result stays fresh. Docs-server tool sets
 * change on deploys, not per request; five minutes of staleness is invisible
 * next to the system-prompt snapshot it supplements.
 */
const TOOL_LIST_TTL_MS = 5 * 60 * 1000;

/** Process-wide `tools/list` cache, keyed by server URL. */
const toolListCache = new Map<string, { definitions: ListToolsResult; expiresAt: number }>();

/** Test seam: drop every cached tool listing. */
export function clearMcpToolListCache(): void {
  toolListCache.clear();
}

function cachedToolList(url: string, now = Date.now()): ListToolsResult | null {
  const entry = toolListCache.get(url);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    toolListCache.delete(url);
    return null;
  }
  return entry.definitions;
}

/** `STUDIO_MCP_URLS` overrides the default; empty string disables MCP entirely. */
export function mcpUrls(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env.STUDIO_MCP_URLS;
  if (configured === undefined) return [ASSEMBLYAI_DOCS_MCP_URL];
  return configured
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
}

export type McpSession = {
  /** Tools to merge into the agent's tool set. Empty when nothing connected. */
  tools: McpTools;
  /** Close every client. Safe to call more than once. */
  close: () => Promise<void>;
};

const noop = async (): Promise<void> => {
  /* nothing connected, nothing to close */
};

const EMPTY: McpSession = { tools: {}, close: noop };

const TIMED_OUT: unique symbol = Symbol("timed out");

/**
 * Race `work` against a `node:timers/promises` sleep. The abort in `finally`
 * clears the timer whichever side wins, so vitest sees no open handles; the
 * losing sleep's AbortError is absorbed by `Promise.race`'s subscription.
 */
async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  const cancel = new AbortController();
  try {
    const result = await Promise.race([work, sleep(ms, TIMED_OUT, { signal: cancel.signal })]);
    if (result === TIMED_OUT) throw new Error(`${label} timed out after ${ms}ms`);
    return result;
  } finally {
    cancel.abort();
  }
}

/** Connect to one server and list its tools, or return null if anything fails. */
async function connectOne(url: string): Promise<{ client: MCPClient; tools: McpTools } | null> {
  try {
    const connecting = createMCPClient({
      transport: { type: "http", url },
      clientName: "aai-studio",
      // A notification arriving after the turn ends must not reach an
      // unhandled rejection and take the server down.
      onUncaughtError: (error) => debug("Studio MCP error", { url, error }),
    });
    let client: MCPClient;
    try {
      client = await withTimeout(connecting, CONNECT_TIMEOUT_MS, `MCP connect (${url})`);
    } catch (err) {
      // A timed-out connect can still resolve later; close that late client
      // instead of leaking one HTTP client per turn while the server is slow.
      // Mirrors the listTools cleanup below.
      connecting.then((late) => late.close()).catch(() => undefined);
      throw err;
    }
    try {
      // The listing is cacheable across turns; the client is not (each tool's
      // `execute` calls back through the client it was built on, and this
      // turn's client closes when the stream settles).
      let definitions = cachedToolList(url);
      if (!definitions) {
        definitions = await withTimeout(client.listTools(), LIST_TIMEOUT_MS, `MCP tools (${url})`);
        toolListCache.set(url, { definitions, expiresAt: Date.now() + TOOL_LIST_TTL_MS });
      }
      return { client, tools: client.toolsFromDefinitions(definitions) };
    } catch (err) {
      await client.close().catch(() => undefined);
      throw err;
    }
  } catch (err) {
    console.warn(`Studio: MCP server unavailable, continuing without it (${url})`, err);
    return null;
  }
}

/**
 * Merge tool sets from several servers, dropping denied names.
 *
 * Exported so the filtering rule can be tested without a live server: the
 * first server wins a name clash, and the caller merges the studio's own
 * tools on top of the result, so a server can never shadow `write_file`.
 */
export function mergeServerTools(sets: readonly McpTools[]): McpTools {
  const tools: McpTools = {};
  for (const serverTools of sets) {
    for (const [name, definition] of Object.entries(serverTools)) {
      if (DENIED_TOOLS.has(name)) continue;
      tools[name] ??= definition;
    }
  }
  return tools;
}

/**
 * Connect to the configured MCP servers and collect their tools.
 *
 * Always resolves — an unreachable server yields an empty tool set rather
 * than an error, so the caller can merge unconditionally.
 */
export async function openMcpTools(env: NodeJS.ProcessEnv = process.env): Promise<McpSession> {
  const urls = mcpUrls(env);
  if (urls.length === 0) return EMPTY;

  const connected = (await Promise.all(urls.map(connectOne))).filter((c) => c !== null);
  if (connected.length === 0) return EMPTY;

  const tools = mergeServerTools(connected.map(({ tools: t }) => t));
  debug("Studio MCP tools", { count: Object.keys(tools).length, servers: connected.length });

  let closed = false;
  return {
    tools,
    close: async () => {
      if (closed) return;
      closed = true;
      await Promise.all(connected.map(({ client }) => client.close().catch(() => undefined)));
    },
  };
}
