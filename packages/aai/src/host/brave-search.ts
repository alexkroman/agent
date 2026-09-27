// Copyright 2026 the AAI authors. MIT license.
/**
 * The `brave_search` builtin — web search through the Brave Search API, for an
 * agent that brings its own `BRAVE_API_KEY`.
 *
 * It sits BESIDE `web_search` rather than replacing it. `web_search` scrapes
 * DuckDuckGo so it needs no credential, and that is also its weakness: the
 * primary endpoint challenges datacenter IPs, which is where a deployed agent
 * runs (see `web-search.ts`). Brave is a real API with a contract and a
 * rate limit you pay for, so an agent whose answers depend on search can trade
 * the key for not being bot-challenged. Brave was `web_search`'s backend
 * once, and was dropped only because the key was required for everyone.
 *
 * The key is read from the AGENT's env on every call (`ctx.env`), never from
 * the host's `process.env` — the platform owns no provider credential. It is
 * not added to `requiredEnv` for you, the same rule an MCP server's `tokenEnv`
 * follows: list it there so a deploy checks it.
 */

import { Parser } from "htmlparser2";
import { z } from "zod";
import { missingEnvMessage } from "../sdk/_missing-env.ts";
import { MAX_JSON_BYTES } from "../sdk/constants.ts";
import type { ToolDef } from "../sdk/types.ts";
import { fetchCappedJson } from "./_fetch-capped.ts";
import { builtinFetch } from "./ssrf.ts";

/** The agent-env variable `brave_search` reads its subscription token from. */
export const BRAVE_API_KEY_ENV = "BRAVE_API_KEY";

const braveSearchParams = z.object({
  query: z.string().min(1).describe("The search query"),
  max_results: z.number().describe("Maximum number of results to return (default 5)").optional(),
  freshness: z
    .enum(["day", "week", "month", "year"])
    .describe("Only return pages published within this window — use for news or recent events")
    .optional(),
});

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const MAX_SEARCH_RESULTS = 10;
const FRESHNESS = { day: "pd", week: "pw", month: "pm", year: "py" } as const;

const BraveResponseSchema = z.object({
  web: z
    .object({
      results: z.array(
        z.object({
          title: z.string(),
          url: z.string(),
          description: z.string().optional(),
          age: z.string().optional(),
        }),
      ),
    })
    .optional(),
});

/**
 * Brave highlights query matches with `<strong>` and entity-encodes the rest.
 * Concatenating the parser's text nodes drops the tags and decodes the
 * entities in one pass — the same reading `web-search.ts` gives DuckDuckGo's
 * `<b>` highlights.
 */
function plainText(html: string): string {
  let text = "";
  const parser = new Parser({
    ontext(chunk) {
      text += chunk;
    },
  });
  parser.write(html);
  parser.end();
  return text.replace(/\s+/g, " ").trim();
}

/** The model reads this, so a rejected key is named as the fix rather than a status. */
function braveError(status: number | undefined, error: string): string {
  if (status === 401 || status === 403 || status === 422) {
    return `Brave Search rejected ${BRAVE_API_KEY_ENV} (${error}) — check the key is valid and has a Search plan`;
  }
  if (status === 429) return `Brave Search rate limit reached (${error}) — try again shortly`;
  return `Brave Search request failed: ${error}`;
}

export function createBraveSearch(
  fetchFn = builtinFetch(),
): ToolDef<typeof braveSearchParams> & { guidance: string } {
  return {
    guidance:
      "Use brave_search for factual questions, current events, or anything you are unsure " +
      "about. Search first rather than guessing.",
    description:
      "Search the web with Brave Search for current information, facts, news, or answers to " +
      "questions. Returns a list of results with title, URL, description, and page age when " +
      "known. Use freshness to restrict to recent pages.",
    inputSchema: braveSearchParams,
    async execute(args, ctx) {
      const key = ctx.env[BRAVE_API_KEY_ENV]?.trim();
      if (!key) return { error: missingEnvMessage(BRAVE_API_KEY_ENV) };
      const count = Math.max(1, Math.min(args.max_results ?? 5, MAX_SEARCH_RESULTS));
      const params = new URLSearchParams({ q: args.query, count: String(count) });
      if (args.freshness) params.set("freshness", FRESHNESS[args.freshness]);
      const res = await fetchCappedJson(`${BRAVE_ENDPOINT}?${params}`, {
        fetch: fetchFn,
        accept: "application/json",
        headers: { "X-Subscription-Token": key },
        maxBytes: MAX_JSON_BYTES,
      });
      if (!res.ok) return { error: braveError(res.status, res.error) };
      const parsed = BraveResponseSchema.safeParse(res.value);
      if (!parsed.success) return { error: "Brave Search response had an unexpected shape" };
      return (parsed.data.web?.results ?? []).slice(0, count).map((r) => ({
        title: plainText(r.title),
        url: r.url,
        description: plainText(r.description ?? ""),
        ...(r.age ? { age: r.age } : {}),
      }));
    },
  };
}
