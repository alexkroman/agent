// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { agentRequiredEnv, derivedRequiredEnv } from "./derived-env.ts";

describe("derivedRequiredEnv", () => {
  test("names every MCP tokenEnv and keyed builtin, deduped", () => {
    expect(
      derivedRequiredEnv({
        mcpServers: {
          docs: { tokenEnv: "DOCS_MCP_TOKEN" },
          wiki: { tokenEnv: "DOCS_MCP_TOKEN" },
          open: {},
        },
        builtinTools: ["think", "brave_search", "google_places", "text_me", "open_meteo"],
      }),
    ).toEqual(["DOCS_MCP_TOKEN", "BRAVE_API_KEY", "GOOGLE_PLACES_API_KEY", "TEXTBELT_KEY"]);
  });

  test("an agent naming neither field derives nothing", () => {
    expect(derivedRequiredEnv({})).toEqual([]);
    expect(derivedRequiredEnv({ builtinTools: ["web_search", "a_future_builtin"] })).toEqual([]);
  });

  test("ignores a malformed tokenEnv rather than inventing a name", () => {
    expect(derivedRequiredEnv({ mcpServers: { docs: { tokenEnv: 42 } } })).toEqual([]);
  });

  test("agentRequiredEnv is requiredEnv first, then the derived names", () => {
    expect(
      agentRequiredEnv({
        requiredEnv: ["ORDERS_API_KEY", "BRAVE_API_KEY"],
        builtinTools: ["brave_search"],
        mcpServers: { docs: { tokenEnv: "DOCS_MCP_TOKEN" } },
      }),
    ).toEqual(["ORDERS_API_KEY", "BRAVE_API_KEY", "DOCS_MCP_TOKEN"]);
  });
});
