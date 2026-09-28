// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { BUILTIN_COVER_AFTER_MS, builtinCover } from "./_builtin-cover.ts";
import { resolveAllBuiltins } from "./builtin-tools.ts";

describe("builtinCover", () => {
  test("is one delayed line and no start line", () => {
    // A start line would speak on every call — the preamble this replaced.
    expect(builtinCover("I'm searching the web.")).toEqual({
      delayed: [{ afterMs: BUILTIN_COVER_AFTER_MS, content: "I'm searching the web." }],
    });
  });

  test("every builtin that waits on the network declares one", () => {
    // Declaring cover is what keeps the generic dead-air phrase out of the
    // turn, so a network builtin without it is back to "I'm checking on this."
    // played into its own answer.
    const network = [
      "web_search",
      "visit_webpage",
      "get_page_design",
      "fetch_json",
      "open_meteo",
      "brave_search",
      "google_places",
      "text_me",
    ];
    const { defs } = resolveAllBuiltins(network);
    for (const name of network) {
      const delayed = defs[name]?.messages?.delayed;
      expect.soft(delayed?.[0]?.afterMs, name).toBe(BUILTIN_COVER_AFTER_MS);
      // Declarative, never a request for patience (see DEAD_AIR_COVER_PHRASES).
      expect.soft(String(delayed?.[0]?.content), name).not.toMatch(/\?|moment|hold|wait for/i);
    }
  });
});
