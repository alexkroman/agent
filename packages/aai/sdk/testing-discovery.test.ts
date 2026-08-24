// Copyright 2026 the AAI authors. MIT license.
/**
 * `deployedAgent` and `withDiscoveredTools` — the two lowerings the BUILD
 * applies and a spec has to apply itself.
 *
 * What is pinned here is mostly the REFUSALS, because that is the whole reason
 * the combined form exists: every wrong version of this produces a green suite
 * measuring the framework defaults, and a test that only checked the happy path
 * would leave the mechanism untested exactly where it earns its keep.
 */

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { agent, tool } from "./define.ts";
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.ts";
import { deployedAgent, withDiscoveredTools } from "./testing-discovery.ts";
import type { ToolModules } from "./tool-registry.ts";

/** What `import.meta.glob("./tools/*.ts", { eager: true })` hands back. */
const glob = (...names: string[]): ToolModules =>
  Object.fromEntries(
    names.map((name) => [
      `./tools/${name}.ts`,
      { default: tool({ description: name, inputSchema: z.object({}), execute: () => name }) },
    ]),
  );

const PROMPT = "You are a retail desk. Identify the caller before anything else.";

describe("withDiscoveredTools", () => {
  test("puts the glob's tools on the def under their file names", () => {
    const def = withDiscoveredTools(agent({ name: "Desk" }), glob("add_item", "view_order"));
    expect(Object.keys(def.tools).sort()).toEqual(["add_item", "view_order"]);
  });

  test("an empty glob leaves the def alone — which is why deployedAgent refuses one", () => {
    const authored = agent({ name: "Desk" });
    expect(withDiscoveredTools(authored, {}).tools).toEqual({});
  });
});

describe("deployedAgent", () => {
  test("applies BOTH lowerings in one call", () => {
    const def = deployedAgent(agent({ name: "Desk" }), {
      tools: glob("add_item"),
      systemPrompt: PROMPT,
    });
    expect(Object.keys(def.tools)).toEqual(["add_item"]);
    expect(def.systemPrompt).toBe(PROMPT);
  });

  test("tools alone, for a project with no system-prompt.md", () => {
    const def = deployedAgent(agent({ name: "Desk" }), { tools: glob("add_item") });
    expect(Object.keys(def.tools)).toEqual(["add_item"]);
    expect(def.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test("the prompt alone, for a project whose tools are inline or builtin", () => {
    const def = deployedAgent(agent({ name: "Coda", builtinTools: ["run_code"] }), {
      systemPrompt: PROMPT,
    });
    expect(def.systemPrompt).toBe(PROMPT);
    expect(def.tools).toEqual({});
  });

  test("an agent.ts that already COMPOSED the file is left exactly as authored", () => {
    // The `pizza-ordering` shape: `agent.ts` imports the prompt itself and
    // appends a computed menu. A spec must not have to know which of the two
    // its own template does, so passing the file is right either way.
    const composed = `${PROMPT}\n\nToday's menu: margherita, marinara.`;
    const def = deployedAgent(agent({ name: "Pizza", systemPrompt: composed }), {
      systemPrompt: PROMPT,
    });
    expect(def.systemPrompt).toBe(composed);
  });

  test("a prompt file nothing reads, beside a DIFFERENT declared prompt, is an error", () => {
    // "I edited system-prompt.md and nothing changed", caught rather than
    // silently producing a plausible, wrong agent.
    expect(() =>
      deployedAgent(agent({ name: "Desk", systemPrompt: "Something else entirely." }), {
        systemPrompt: PROMPT,
      }),
    ).toThrow(/system-prompt\.md exists and nothing reads it/);
  });

  test("NO project files at all is refused, naming both fields", () => {
    expect(() => deployedAgent(agent({ name: "Desk" }), {})).toThrow(
      /no project files.*import\.meta\.glob.*systemPrompt/s,
    );
  });

  test("an EMPTY tools glob is refused — the silent half of the same bug", () => {
    // `import.meta.glob("./tool/*.ts")`, or a tools/ directory that moved:
    // lowering nothing is indistinguishable from not lowering at all, and the
    // eval then measures a seventeen-tool desk with no tools.
    expect(() => deployedAgent(agent({ name: "Desk" }), { tools: {} })).toThrow(/EMPTY tools glob/);
  });

  test("an empty tools glob is refused even when a prompt WAS given", () => {
    expect(() =>
      deployedAgent(agent({ name: "Desk" }), { tools: {}, systemPrompt: PROMPT }),
    ).toThrow(/EMPTY tools glob/);
  });

  test("an empty system-prompt.md is refused rather than taken as a prompt", () => {
    expect(() => deployedAgent(agent({ name: "Desk" }), { systemPrompt: "   \n" })).toThrow(
      /system-prompt\.md is empty/,
    );
  });

  test("the build's own tool rules still apply, naming the file", () => {
    expect(() =>
      deployedAgent(agent({ name: "Desk" }), { tools: { "./tools/Add Item.ts": { default: {} } } }),
    ).toThrow();
  });
});
