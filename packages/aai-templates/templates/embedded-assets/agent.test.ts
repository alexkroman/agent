/// <reference types="vite/client" />

import type { ToolContext } from "@alexkroman1/aai";
import { createToolContext, runTool, withDiscoveredTools } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import authoredAgent from "./agent.ts";
import { faqs, searchable } from "./shared.ts";

/**
 * The def a DEPLOYED agent runs: authored, plus what `tools/` declares.
 *
 * The glob is written HERE rather than reached for from a shared helper because
 * this file SHIPS — a scaffolded project has no `../../_discovery.ts` to import,
 * and `import.meta.glob` is expanded against the file containing it either way.
 */
const agentDef = withDiscoveredTools(
  authoredAgent,
  import.meta.glob("./tools/*.ts", { eager: true }),
);

const run = (name: string, args: Record<string, unknown>, ctx: ToolContext) =>
  runTool(agentDef, name, args, ctx);

describe("embedded-assets template", () => {
  test("the JSON asset really is bundled, and the index is built from it", () => {
    // The template's whole subject: an asset imported with an import attribute,
    // resolved at build time rather than fetched. An empty knowledge base would
    // make every search below trivially "not found".
    expect(faqs.length).toBeGreaterThan(0);
    expect(searchable).toHaveLength(faqs.length);
    for (const entry of faqs) {
      expect(entry.question).toBeTypeOf("string");
      expect(entry.answer).toBeTypeOf("string");
    }
  });

  test("both tools are discovered from tools/", () => {
    // `agent()` takes no `tools` field: a file in `tools/` IS the tool, and
    // nothing imports it. Discovery is what puts it in front of the model, so a
    // template whose tools are never resolved ships a model with no tools.
    expect(Object.keys(agentDef.tools ?? {}).sort()).toEqual(["list_topics", "search_knowledge"]);
  });
});

describe("list_topics", () => {
  test("answers with every question in the knowledge base", async () => {
    const topics = await run("list_topics", {}, createToolContext());
    expect(topics).toEqual(faqs.map((f) => f.question));
  });
});

describe("search_knowledge", () => {
  test("scores by word overlap rather than by substring", async () => {
    // The reason the tool does not just `includes()` the query: a caller asks a
    // natural question, which is never a substring of an FAQ entry.
    const target = faqs[0];
    if (!target) throw new Error("the knowledge base is empty");
    const words = target.question
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2);
    const result = await run(
      "search_knowledge",
      { query: `hey, could you tell me ${words.join(" ")}?` },
      createToolContext(),
    );
    expect(result).toEqual(target);
  });

  test("a query with no words longer than two characters is refused early", async () => {
    // The guard before the scan: with no scoreable words every entry ties at
    // zero, and returning the first one would be an answer to nothing.
    expect(await run("search_knowledge", { query: "is it a" }, createToolContext())).toEqual({
      result: "No matching FAQ found.",
    });
  });

  test("a query that overlaps nothing reports no match rather than guessing", async () => {
    expect(
      await run("search_knowledge", { query: "zzzqqq wibbleflange" }, createToolContext()),
    ).toEqual({ result: "No matching FAQ found." });
  });
});
