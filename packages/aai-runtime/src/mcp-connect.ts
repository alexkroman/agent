// Copyright 2026 the AAI authors. MIT license.
/**
 * Opening one MCP server, and the seam every caller here talks to instead of
 * the vendor client.
 *
 * {@link McpSession} is two methods — list, close — and it is what
 * `mcp-tools.ts` depends on. `@ai-sdk/mcp`'s `createMCPClient` sits behind
 * {@link openMcpSession} and nowhere else, which buys two things: a spec drives
 * a session with no network and no vendor client, and the day this repo's
 * transport requirements outgrow it the change is one module.
 *
 * ## Why `@ai-sdk/mcp` rather than the protocol SDK
 *
 * A first cut of this used `@modelcontextprotocol/sdk` directly and is deleted.
 * Three things decided it, and the middle one is the substantive one:
 *
 * - **The tools arrive in AI SDK shape.** `client.tools()` answers a `ToolSet`,
 *   the same type `streamText` and `to-vercel-tools.ts` already speak, so the
 *   listing → declaration path is the SDK's own rather than ~80 lines of
 *   hand-written mapping over a zod-inferred vendor type that is assignable to
 *   no JSON Schema type in either direction.
 * - **`fingerprintTools`/`detectToolDrift` (from `ai`) take that shape**, which
 *   is what makes the rug-pull defence in `mcp-tools.ts` a call rather than a
 *   hash function somebody here would have had to define, and get right, and
 *   keep in step with what a server can change.
 * - **It is already in the tree.** `ai` pulls it transitively, so declaring it
 *   directly added zero packages to the install, against the protocol SDK's 25
 *   (express, hono, cors, jose, ajv, pkce-challenge…), every one of them
 *   transitive into every consumer of a PUBLISHED package.
 *
 * ## HTTP only, and stdio is REFUSED rather than discouraged
 *
 * `transport: { type: "http" }` — streamable HTTP, with the SSE stream the same
 * transport opens where a server offers one. `@ai-sdk/mcp` DOES ship a stdio
 * transport (`@ai-sdk/mcp/mcp-stdio`) and this module never imports it:
 * stdio spawns a subprocess, and inside the Modal guest sandbox that is a
 * materially different security question from opening a socket — process
 * lifetime, what the child inherits, what a compromised server can then reach.
 * `sdk/mcp-config.ts`'s schema refuses a non-`http(s)` URL, so the refusal is at
 * the config boundary where an author can see it, and the import is absent here
 * so a later edit has to add one deliberately.
 *
 * ## Every byte goes through the SDK's SSRF-screened fetch
 *
 * `MCPTransportConfig` takes a `fetch`, and we hand it {@link safeFetch}: the
 * URL is validated against private and reserved ranges, DNS is pinned so the
 * address that was screened is the address dialled, each redirect hop is
 * re-validated, and `authorization` is dropped when a redirect leaves the
 * original origin. An MCP server URL is configuration, and in the studio the
 * configuration can be authored by a model — so it is screened on every
 * deployment rather than only off-platform.
 *
 * **Not `rpcFetch`/`blobFetch`, and the reason is mechanical rather than a
 * preference.** Those attach the pool's own `dispatcher` to every request,
 * which would overwrite the pinned dispatcher `ssrfSafeFetch` installs — i.e.
 * taking the pool means giving up the DNS pinning, which is the half of the
 * screen that survives a rebind. `guard-invariants` rule 29 bans
 * `globalThis.fetch` as the default here, and `safeFetch` is not it: it is
 * `pinnedFetch` (undici's, matching the dispatcher) plus the screen.
 *
 * Note our fetch OWNS the redirect policy. The transport's own `redirect`
 * option (`'error'` by default) never takes effect, because `ssrfSafeFetch`
 * rewrites the request to `redirect: "manual"` and walks the hops itself —
 * which is the stronger behaviour of the two, since it re-screens each target
 * and strips credentials at the origin boundary rather than refusing outright.
 *
 * ## A failure here is one SERVER's failure
 *
 * Nothing in this module is allowed to be the reason a voice session does not
 * start. {@link openMcpSession} bounds the whole connect-and-initialize with
 * `p-timeout` and, on any failure, closes what it opened before rethrowing —
 * the caller turns that into "this server's tools are unavailable" and keeps
 * going.
 */

import { safeFetch } from "@alexkroman1/aai/host-internal";
import { isRecord } from "@alexkroman1/aai/utils";
import type { ToolSet } from "ai";
import pTimeout from "p-timeout";

/**
 * How long a server has to accept a connection, complete the MCP handshake and
 * answer `tools/list`.
 *
 * A voice session is the deadline that matters: an agent whose greeting waits
 * on a wedged third party is worse than one missing that server's tools, and
 * the caller is listening to silence either way. Ten seconds is generous for a
 * handshake plus one list and short enough that a dead server costs one boot
 * rather than one call.
 */
export const MCP_CONNECT_TIMEOUT_MS = 10_000;

/** What this client calls itself in the MCP handshake. */
const MCP_CLIENT_NAME = "aai-runtime";

/**
 * The version reported in the handshake.
 *
 * A literal rather than this package's `version`: reading `package.json` at
 * runtime is a filesystem read in a module that has none, and the field is
 * advisory — no server routes on it.
 */
const MCP_CLIENT_VERSION = "1";

/** One MCP server with its credential already resolved out of the agent env. */
export type ResolvedMcpServer = {
  /** The author's key for this server — the first segment of its tool names. */
  key: string;
  /** The endpoint, already checked as `http(s)` by the config schema. */
  url: string;
  /** The bearer token read from `tokenEnv`, absent when the server needs none. */
  token?: string;
};

/**
 * What a `tools/call` came back with, flattened.
 *
 * MCP answers a rich content list (text, images, audio, resource links) and an
 * `isError` flag; a tool result in this SDK is one JSON-serializable value. So
 * the flattening happens HERE, once, rather than in each tool body: text parts
 * are joined, `structuredContent` is preferred when the server sent it, and
 * `isError` is kept separate so `mcp-tools.ts` can decide it is a
 * `ToolFailure` rather than an answer.
 */
export type McpCallResult = {
  /** The server's own `isError`, i.e. "the tool ran and it went wrong". */
  isError: boolean;
  /** Every `text` part joined by newlines — `""` when the reply carried none. */
  text: string;
  /** The server's `structuredContent`, when it sent one. */
  structured?: Record<string, unknown>;
  /**
   * The `type` of every non-text part, in order.
   *
   * Kept because dropping them silently is the failure worth avoiding: a server
   * answering with an image only would otherwise look like a tool that returned
   * nothing. `mcp-tools.ts` names them in the value the model sees.
   */
  otherParts: readonly string[];
};

/**
 * A live connection to one server.
 *
 * Two methods, because two are what the tool surface needs. Note it hands back
 * the AI SDK's `ToolSet` rather than a shape of ours: that is the type
 * `fingerprintTools` reads, so reducing it here would mean re-deriving the
 * fingerprint from a lossy copy.
 */
export type McpSession = {
  tools(): Promise<ToolSet>;
  close(): Promise<void>;
};

/**
 * How a session is opened. The seam a spec fills: it takes a resolved server
 * and hands back something that answers the two methods, so a test drives
 * discovery, a call, a collision, a drift and a timeout with no socket
 * anywhere.
 */
export type McpSessionOpener = (server: ResolvedMcpServer) => Promise<McpSession>;

/** Options {@link openMcpSession} takes; every one of them is a test seam. */
export type McpConnectOptions = {
  /**
   * `fetch` for the transport. Callers must leave it unset — same rule as
   * `safeFetch`'s own: naming an implementation is how you opt out of the
   * screening this module exists to keep.
   */
  fetch?: typeof globalThis.fetch | undefined;
  /** Overrides {@link MCP_CONNECT_TIMEOUT_MS}. */
  connectTimeoutMs?: number | undefined;
};

/** Flatten a `tools/call` reply into {@link McpCallResult}. */
export function toCallResult(result: unknown): McpCallResult {
  if (!isRecord(result)) {
    return { isError: false, text: "", otherParts: [] };
  }
  const texts: string[] = [];
  const otherParts: string[] = [];
  const content = result.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
      else if (typeof part.type === "string") otherParts.push(part.type);
    }
  }
  const structured = result.structuredContent;
  const call: McpCallResult = {
    isError: result.isError === true,
    text: texts.join("\n"),
    otherParts,
  };
  if (isRecord(structured)) call.structured = structured;
  return call;
}

/**
 * Adopt a connect this caller has given up on.
 *
 * A timed-out `createMCPClient` is still in flight: nothing has cancelled it,
 * so it will settle later. Both outcomes need handling and neither is
 * actionable — a rejection with no owner is an unhandled rejection and, by
 * default, a dead process, and a client that arrives after the deadline is a
 * half-open socket pinned for the life of the process. So this awaits it and
 * closes whatever turns up.
 *
 * A function rather than a `.then(onFulfilled, onRejected)` at the call site,
 * which reads as nested promises and is what `noNestedPromises` is for.
 */
async function discardLateConnect(pending: Promise<{ close(): Promise<void> }>): Promise<void> {
  try {
    const late = await pending;
    await late.close();
  } catch {
    // By construction there is nothing to report: the caller has already
    // thrown the reason it gave up, and this arm's failure is about a
    // connection nobody is waiting for.
  }
}

/**
 * Connect to one server over streamable HTTP and hand back its session.
 *
 * Rejects — bounded by {@link MCP_CONNECT_TIMEOUT_MS} — when the server is
 * unreachable, refuses the handshake, or is simply slow. The caller
 * (`mcp-tools.ts`) is what turns that into a degraded surface rather than a
 * failed session, which is why this one throws instead of returning a status.
 */
/**
 * `@ai-sdk/mcp`, loaded on the first connect rather than imported at module
 * load, and an OPTIONAL PEER rather than a dependency.
 *
 * MCP is opt-in: an agent that declares no `mcpServers` never reaches this
 * function. A plain `import` would still put the package in the tree of every
 * consumer of `@alexkroman1/aai-runtime`, which is what
 * `artifact-size-report.mjs` fails a new runtime dependency over regardless of
 * its bytes — a transitive cost paid by everyone for a feature most agents do
 * not use. Unlike `tokenx` this one cannot be bundled: it resolves
 * `@ai-sdk/provider-utils` and shares that module's identity with `ai`, so an
 * inlined second copy would be a different module to the one `ai` holds.
 *
 * The failure when it is absent is therefore a real path, not a theoretical
 * one, and it is answered with the install line rather than a bare
 * `ERR_MODULE_NOT_FOUND` naming a package the author never wrote down.
 */
async function loadCreateMcpClient(): Promise<typeof import("@ai-sdk/mcp").createMCPClient> {
  try {
    return (await import("@ai-sdk/mcp")).createMCPClient;
  } catch (cause) {
    throw new Error(
      "An agent declares `mcpServers`, which needs the optional peer " +
        "`@ai-sdk/mcp`. Install it alongside `@alexkroman1/aai-runtime`: " +
        "`pnpm add @ai-sdk/mcp`.",
      { cause },
    );
  }
}

export async function openMcpSession(
  server: ResolvedMcpServer,
  options: McpConnectOptions = {},
): Promise<McpSession> {
  const headers: Record<string, string> = {};
  if (server.token) headers.authorization = `Bearer ${server.token}`;
  const budget = options.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS;
  const createMCPClient = await loadCreateMcpClient();
  const connecting = createMCPClient({
    transport: {
      type: "http",
      url: server.url,
      headers,
      fetch: options.fetch ?? safeFetch,
    },
    clientName: MCP_CLIENT_NAME,
    version: MCP_CLIENT_VERSION,
    // Retries are the TOOL EXECUTOR's business, not the transport's: a tool
    // call already runs under one deadline and one abort signal there, and a
    // second retry policy underneath makes a timed-out MCP tool cost some
    // multiple of the budget the executor thinks it granted.
    maxRetries: 0,
  });
  let client: Awaited<typeof connecting>;
  try {
    client = await pTimeout(connecting, {
      milliseconds: budget,
      message: `MCP server "${server.key}" did not complete its handshake within ${budget}ms`,
    });
  } catch (cause) {
    void discardLateConnect(connecting);
    throw cause;
  }
  return {
    tools: async () => await client.tools(),
    close: async () => {
      await client.close();
    },
  };
}
