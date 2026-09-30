// Copyright 2026 the AAI authors. MIT license.
/**
 * One declared MCP server's `url`, `headers` and token, RESOLVED for one
 * connection — and the `allowedTools` scope applied to what it lists.
 *
 * Split from `mcp-tools.ts` so the resolution rules (a resolver's context, the
 * http(s) re-check of a computed URL, what a status may say the endpoint is)
 * have one home that both `withMcpTools` and `stepMcp`'s connector go through.
 * The SSRF screen itself is not here: it runs on every request, resolved URL
 * or literal, in `mcp-connect.ts`.
 */

import type { McpResolvable, McpResolveContext, McpServerConfig } from "@alexkroman1/aai";
import type { ToolSet } from "ai";
import type { ResolvedMcpServer } from "./mcp-connect.ts";
import type { Logger } from "./runtime-config.ts";

/**
 * What the status and every log line say the server's endpoint is.
 *
 * A literal URL is shown as written: it is not a secret, and it is what the
 * author is looking at. A RESOLVED one is shown as its origin only, because a
 * resolver exists precisely to compute something per user — a vendor session
 * URL carries a session id in its path, and a log line is not where that goes.
 */
export function displayUrl(config: McpServerConfig, resolved?: string): string {
  if (typeof config.url === "string") return config.url;
  const origin = resolved === undefined ? undefined : URL.parse(resolved)?.origin;
  return origin ?? "(resolved per connection)";
}

/** Call a resolver, or hand back the literal it stands for. */
async function resolveValue<T>(value: McpResolvable<T>, context: McpResolveContext): Promise<T> {
  return typeof value === "function"
    ? await (value as (c: McpResolveContext) => T | Promise<T>)(context)
    : value;
}

/**
 * Read one declared server's endpoint, headers and credential — calling the
 * author's resolvers, when they wrote functions, with the client this
 * connection acts for.
 *
 * A `tokenEnv` naming a variable that is not set FAILS this server by name,
 * rather than connecting unauthenticated and meeting a 401 per session: the
 * author said the server needs a credential, so the absence is a
 * misconfiguration and the message is the only useful thing to produce.
 *
 * A resolved URL is re-checked as `http(s)` here, because the config schema
 * only ever saw the literal spelling: a resolver answering `file:` or
 * `stdio:` must meet the same refusal a literal would. (The SSRF screen then
 * runs on every request, resolved or not, in `mcp-connect.ts`.)
 */
export async function resolveServer(
  key: string,
  config: McpServerConfig,
  context: McpResolveContext,
): Promise<{ server: ResolvedMcpServer } | { unavailable: string }> {
  const url = await resolveValue(config.url, context);
  const protocol = typeof url === "string" ? URL.parse(url)?.protocol : undefined;
  if (protocol !== "http:" && protocol !== "https:") {
    return {
      unavailable: `the "${key}" MCP server's url resolver did not return an http(s) URL — stdio and other transports are not supported`,
    };
  }
  const server: ResolvedMcpServer = { key, url };
  if (config.headers !== undefined) {
    server.headers = { ...(await resolveValue(config.headers, context)) };
  }
  if (config.tokenEnv === undefined) return { server };
  const token = context.env[config.tokenEnv];
  if (!token) {
    return {
      unavailable: `${config.tokenEnv} is not set. The "${key}" MCP server declares tokenEnv: "${config.tokenEnv}", so set that variable (and list it in the agent's requiredEnv so a deploy checks it) or drop tokenEnv for a server that needs no credential.`,
    };
  }
  server.token = token;
  return { server };
}

/**
 * Keep only the tools the author allowed, and say which allowed names the
 * server did not publish — usually a typo or a renamed tool, and silent
 * otherwise, since the tool would simply never appear.
 */
export function allowTools(
  key: string,
  tools: ToolSet,
  allowed: readonly string[] | undefined,
  logger: Logger | undefined,
): ToolSet {
  if (allowed === undefined) return tools;
  const kept: ToolSet = {};
  for (const name of allowed) {
    const tool = tools[name];
    if (tool === undefined) {
      logger?.warn(
        `MCP server "${key}" lists "${name}" in allowedTools, but the server does not publish a tool by that name.`,
      );
      continue;
    }
    kept[name] = tool;
  }
  return kept;
}
