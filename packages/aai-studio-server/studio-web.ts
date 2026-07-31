// Copyright 2026 the AAI authors. MIT license.
/**
 * Web access for the studio's coding agent.
 *
 * These are the SDK's own `visit_webpage`, `get_page_design`, and
 * `web_search` builtins, not new implementations. Reusing them means the
 * studio inherits `safeFetch` — the SSRF guard that resolves and pins a
 * public IP, re-validates every redirect hop, and strips credential headers
 * across origins. A URL here is model-controlled and the studio runs on the
 * platform host, so that guard is the whole ballgame; a hand-rolled `fetch`
 * would be a server-side request forgery hole pointed at the metadata
 * endpoint.
 *
 * All three builtins are keyless — `web_search` is DuckDuckGo-backed (see
 * the SDK's builtin-tools.ts), so nothing here reads host env and the tool
 * set never varies by configuration.
 *
 * `visit_webpage` also already does the part opencode's webfetch uses
 * Turndown for — HTML to clean text, with byte and character caps and a
 * `truncated` flag.
 */

import type { ToolContext, ToolDef } from "@alexkroman1/aai";
import { resolveAllBuiltins } from "@alexkroman1/aai/runtime";
import { jsonSchema, type ToolSet, tool } from "ai";
import type { z } from "zod";

/** Builtins the coding agent gets — all keyless. */
const WEB_BUILTINS = ["visit_webpage", "get_page_design", "web_search"] as const;

const SESSION_ID = "studio-web";

/**
 * The context a builtin's `execute` receives. Deliberately bare: the coding
 * agent is not a deployed agent, so there is no session state, no app
 * database, no client to `send` to — and an empty env, so a coding turn can
 * never read a host credential through a tool context.
 */
function toolContext(): ToolContext {
  return {
    env: {},
    state: {},
    // The web builtins never touch ctx.db; a coding turn has no app database.
    db: {
      query: () => Promise.reject(new Error("Storage is not available in studio web tools")),
    },
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

/** The builtins the coding agent is offered. */
export function webBuiltinNames(): string[] {
  return [...WEB_BUILTINS];
}

/** Build the coding agent's web tools. */
export function createWebTools(): ToolSet {
  const names = webBuiltinNames();
  const { defs, schemas } = resolveAllBuiltins(names);
  const ctx = toolContext();
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
