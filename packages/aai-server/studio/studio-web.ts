// Copyright 2026 the AAI authors. MIT license.
/**
 * Web access for the studio's coding agent.
 *
 * These are the SDK's own `visit_webpage` and `web_search` builtins, not new
 * implementations. Reusing them means the studio inherits `safeFetch` — the
 * SSRF guard that resolves and pins a public IP, re-validates every redirect
 * hop, and strips credential headers across origins. A URL here is
 * model-controlled and the studio runs on the platform host, so that guard is
 * the whole ballgame; a hand-rolled `fetch` would be a server-side request
 * forgery hole pointed at the metadata endpoint.
 *
 * `visit_webpage` also already does the part opencode's webfetch uses
 * Turndown for — HTML to clean text, with byte and character caps and a
 * `truncated` flag.
 *
 * MCP covers AssemblyAI's own docs (see `studio-mcp.ts`); this covers
 * everything else — a third-party API the agent is wiring a tool up against,
 * a page the user pasted.
 */

import type { ToolContext, ToolDef } from "@alexkroman1/aai";
import { createMemoryVector, resolveAllBuiltins } from "@alexkroman1/aai/runtime";
import { jsonSchema, type ToolSet, tool } from "ai";
import type { z } from "zod";

/** Builtins the coding agent gets. `web_search` is dropped without a key. */
const WEB_BUILTINS = ["visit_webpage", "get_page_design", "web_search"] as const;

/** Agent-env variable backing the SDK's `web_search` builtin (Brave Search). */
const BRAVE_API_KEY_ENV = "BRAVE_API_KEY";

const SESSION_ID = "studio-web";

/**
 * The context a builtin's `execute` receives. Deliberately bare: the coding
 * agent is not a deployed agent, so there is no session state, no app
 * database, and no client to `send` to. Only `env` carries anything, and
 * only the search key.
 */
function toolContext(env: NodeJS.ProcessEnv): ToolContext {
  return {
    env: env[BRAVE_API_KEY_ENV] ? { [BRAVE_API_KEY_ENV]: env[BRAVE_API_KEY_ENV] } : {},
    state: {},
    // The web builtins never touch ctx.db; a coding turn has no app database.
    db: {
      query: () => Promise.reject(new Error("Storage is not available in studio web tools")),
    },
    vector: createMemoryVector({ namespace: SESSION_ID }),
    // The web builtins never call ctx.generate; the studio's own LLM loop is
    // the generation surface for a coding turn.
    generate: () => Promise.reject(new Error("generate is not available in studio web tools")),
    messages: [],
    sessionId: SESSION_ID,
    send: () => {
      /* no connected browser client for a coding turn */
    },
  };
}

/** Which builtins to offer, given what the host is configured for. */
export function webBuiltinNames(env: NodeJS.ProcessEnv = process.env): string[] {
  // web_search returns "BRAVE_API_KEY is not set" without a key. Offering a
  // tool that can only fail wastes a turn, so drop it instead.
  return WEB_BUILTINS.filter((name) => name !== "web_search" || Boolean(env[BRAVE_API_KEY_ENV]));
}

/**
 * Build the coding agent's web tools. Returns `{}` when none are available.
 */
export function createWebTools(env: NodeJS.ProcessEnv = process.env): ToolSet {
  const names = webBuiltinNames(env);
  if (names.length === 0) return {};

  const { defs, schemas } = resolveAllBuiltins(names);
  const ctx = toolContext(env);
  const out: ToolSet = {};

  for (const schema of schemas) {
    const def: ToolDef | undefined = defs[schema.name];
    if (!def) continue;
    out[schema.name] = tool({
      description: schema.description,
      inputSchema: jsonSchema(schema.parameters),
      execute: async (args: unknown) => {
        const parsed = def.parameters
          ? ((def.parameters as z.ZodType).safeParse(args ?? {}) as z.ZodSafeParseResult<unknown>)
          : { success: true as const, data: args ?? {} };
        if (!parsed.success) return { error: `Invalid arguments: ${parsed.error.message}` };
        return await def.execute(parsed.data as never, ctx);
      },
    });
  }
  return out;
}
