/// <reference types="vite/client" />

import { toAgentConfig } from "@alexkroman1/aai/manifest";
import { createToolContext, runTool, withDiscoveredTools } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import authoredAgent from "./agent.ts";
import { CATEGORIES, MOODS } from "./shared.ts";

/**
 * The def a DEPLOYED agent runs: authored, plus what `tools/` declares.
 *
 * The glob is written HERE rather than reached for from a shared helper because
 * this file SHIPS — a scaffolded project has no repo helper to import.
 */
const agentDef = withDiscoveredTools(
  authoredAgent,
  import.meta.glob("./tools/*.ts", { eager: true }),
);

describe("night-owl template", () => {
  test("config passes manifest validation", () => {
    // Same conversion `aai build`/`aai deploy` run.
    expect(() => toAgentConfig(agentDef)).not.toThrow();
  });

  test("declares run_code, which is the other half of the template", () => {
    // The sleep-time arithmetic is the builtin's job, not a tool's — that split
    // IS this template's subject, so a dropped builtin leaves the agent doing
    // mental arithmetic out loud.
    expect(agentDef.builtinTools).toContain("run_code");
  });

  test("recommend is discovered from tools/", () => {
    expect(Object.keys(agentDef.tools ?? {})).toEqual(["recommend"]);
  });
});

describe("recommend", () => {
  test("answers with picks for the category and mood asked for", async () => {
    const ctx = createToolContext();
    const result = await runTool(agentDef, "recommend", { category: "movie", mood: "cozy" }, ctx);
    expect(result).toMatchObject({ category: "movie", mood: "cozy" });
    expect((result as { picks: string[] }).picks.length).toBeGreaterThan(0);
  });

  test("pushes the same picks to the client, which is what the page renders", async () => {
    // `ctx.send` is the only reason this tool takes a context at all: the
    // client renders the picks rather than waiting to hear them read aloud.
    const ctx = createToolContext();
    const result = await runTool(agentDef, "recommend", { category: "book", mood: "spooky" }, ctx);
    expect(ctx.sent).toEqual([{ event: "recommendations", data: result }]);
  });

  test("every category/mood pair the schema admits has picks behind it", async () => {
    // The table is hand-written and the schema is generated from the same two
    // const arrays, so a category added to `shared.ts` and forgotten in the
    // table is a `TypeError` on the first call — the exact failure this
    // package's guide records three shipped tools having.
    for (const category of CATEGORIES) {
      for (const mood of MOODS) {
        const result = await runTool(
          agentDef,
          "recommend",
          { category, mood },
          createToolContext(),
        );
        expect((result as { picks: string[] }).picks, `${category}/${mood}`).not.toHaveLength(0);
      }
    }
  });

  test("a mood outside the enum is refused by the schema", async () => {
    // The wire boundary: an LLM tool call is untyped, so the schema is the only
    // thing between a hallucinated mood and an index into `undefined`.
    const schema = agentDef.tools?.recommend?.inputSchema;
    if (!schema) throw new Error("recommend has no input schema");
    const bad = await schema["~standard"].validate({ category: "movie", mood: "melancholy" });
    expect(bad.issues).toBeDefined();
  });
});
