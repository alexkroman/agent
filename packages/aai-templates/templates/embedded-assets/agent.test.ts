/** The def a DEPLOYED agent runs: authored, plus what `tools/` declares. */
import agentDef from "virtual:aai/agent";
import { toolRunner } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import { faqs, searchable } from "./shared.ts";

/**
 * Both tools here are stateless, so no call passes a context: `runTool` builds
 * a fresh one, which is a distinct session with empty slots — right for a tool
 * that reads nothing but its arguments, and never what two calls sharing state
 * want. `list_topics` takes no arguments either, and may say so by leaving them
 * out rather than passing a `{}` between the two values a reader cares about.
 */
const run = toolRunner(agentDef);

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
    // `arrayContaining` rather than an exact list: adding a file to `tools/` is
    // the edit this template most invites, and an exact list would redden on
    // it. Losing one of these two is still a failure — that is the half worth
    // asserting.
    expect(Object.keys(agentDef.tools ?? {})).toEqual(
      expect.arrayContaining(["list_topics", "search_knowledge"]),
    );
  });
});

describe("list_topics", () => {
  test("answers with every question in the knowledge base", async () => {
    const topics = await run("list_topics");
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
    const result = await run("search_knowledge", {
      query: `hey, could you tell me ${words.join(" ")}?`,
    });
    expect(result).toEqual(target);
  });

  test("a query with no words longer than two characters is refused early", async () => {
    // The guard before the scan: with no scoreable words every entry ties at
    // zero, and returning the first one would be an answer to nothing.
    expect(await run("search_knowledge", { query: "is it a" })).toEqual({
      result: "No matching FAQ found.",
    });
  });

  test("a query that overlaps nothing reports no match rather than guessing", async () => {
    expect(await run("search_knowledge", { query: "zzzqqq wibbleflange" })).toEqual({
      result: "No matching FAQ found.",
    });
  });
});
