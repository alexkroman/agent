// Copyright 2025 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * Build-smoke test for every template.
 *
 * Imports each template's agent.ts (through the same import shapes the CLI
 * bundler supports — `.md` raw strings via the plugin in vitest.config.ts,
 * `.json` natively) and runs the config through `toAgentConfig` +
 * `agentToolsToSchemas`, the exact validation path `aai build`/`aai deploy`
 * use (see packages/aai-cli/_bundler.ts).
 *
 * This catches, for every template — not just the ones the e2e tier builds:
 * - a renamed/missing asset import (system-prompt.md, knowledge.json)
 * - a config the manifest layer would reject (partial provider triple,
 *   invalid text-only tuning, bad silence policy)
 *
 * Deliberately config-level only: tool behavior belongs in each template's
 * own agent.test.ts.
 */

import { agentToolsToSchemas, toAgentConfig } from "@alexkroman1/aai/manifest";
import { describe, expect, test } from "vitest";

/** What a template's default export must satisfy — derived from the exact
 * functions the CLI bundler feeds it to. */
type AgentDefLike = Parameters<typeof toAgentConfig>[0] & {
  tools?: Parameters<typeof agentToolsToSchemas>[0];
};

// Lazy glob: each agent.ts (and its asset imports) is only loaded inside its
// own test case, so one broken template fails one test, not collection.
const agentModules = import.meta.glob("./templates/*/agent.ts");

const templates = Object.keys(agentModules)
  .map((modulePath) => {
    // Key shape: "./templates/<name>/agent.ts"
    const name = modulePath.split("/")[2];
    if (!name) throw new Error(`Unexpected glob key: ${modulePath}`);
    return { name, modulePath };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

describe("template build smoke", () => {
  test("discovers templates", () => {
    expect(templates.length).toBeGreaterThan(0);
  });

  test.each(templates)(
    "$name: agent.ts loads and yields a valid config",
    async ({ name, modulePath }) => {
      const load = agentModules[modulePath];
      if (!load) throw new Error(`No loader for ${modulePath}`);
      const mod = (await load()) as { default?: AgentDefLike };
      const agentDef = mod.default;
      expect(agentDef, `${name}/agent.ts must default-export agent({...})`).toBeDefined();
      if (!agentDef) return;

      expect(typeof agentDef.name).toBe("string");
      expect(agentDef.name.length).toBeGreaterThan(0);

      // Same conversion the CLI bundler runs at deploy time.
      expect(() => toAgentConfig(agentDef)).not.toThrow();
      expect(() => agentToolsToSchemas(agentDef.tools ?? {})).not.toThrow();
    },
  );
});
