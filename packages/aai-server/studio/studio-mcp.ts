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
 * **Failure is never fatal.** A server that is down, slow, or returns
 * nonsense must not take the turn with it — the agent still has its file
 * tools and the embedded guide. Every failure path here degrades to "no MCP
 * tools this turn" and logs.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
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
 * How long to wait for connect + tool listing before giving up on MCP for
 * this turn. The user is watching a chat box; a slow docs server should cost
 * them a lookup, not the reply.
 */
const CONNECT_TIMEOUT_MS = 5000;

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
    const client = await withTimeout(
      createMCPClient({
        transport: { type: "http", url },
        clientName: "aai-studio",
        // A notification arriving after the turn ends must not reach an
        // unhandled rejection and take the server down.
        onUncaughtError: (error) => debug("Studio MCP error", { url, error }),
      }),
      CONNECT_TIMEOUT_MS,
      `MCP connect (${url})`,
    );
    try {
      const tools = await withTimeout(client.tools(), CONNECT_TIMEOUT_MS, `MCP tools (${url})`);
      return { client, tools };
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
