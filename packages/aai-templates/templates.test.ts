// Copyright 2025 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * Build-smoke test for every template.
 *
 * Imports each template's agent.ts (through the same import shapes the CLI
 * bundler supports — `?raw`-suffixed raw strings and `.json`, both native
 * to Vite/vitest) and runs the config through `toAgentConfig` +
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

import { DEFAULT_MAX_STEPS, TOOL_EXECUTION_TIMEOUT_MS } from "@alexkroman1/aai";
import { agentToolsToSchemas, toAgentConfig } from "@alexkroman1/aai/manifest";
import { ASSEMBLYAI_TTS_DEPRECATED_VOICES, ASSEMBLYAI_TTS_VOICES } from "@alexkroman1/aai/tts";
import { describe, expect, test } from "vitest";
// `?raw` rather than node:fs — this package's tsconfig has no node types, and
// the raw-import shape is the one the CLI bundler supports anyway.
import scaffoldGuide from "./scaffold/CLAUDE.md?raw";
import scaffoldWorkspaceYaml from "./scaffold/pnpm-workspace.yaml?raw";

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

/**
 * The scaffold guide is what a coding agent reads when it picks a voice, and
 * a wrong id there is invisible until a live session goes silent. Two
 * hand-maintained lists had already drifted into naming voices that do not
 * exist, so the guide is pinned to the SDK catalog in both directions.
 */
describe("scaffold guide voice catalog", () => {
  const guide = scaffoldGuide;

  test("lists every current voice", () => {
    const missing = Object.keys(ASSEMBLYAI_TTS_VOICES).filter((v) => !guide.includes(`\`${v}\``));
    expect(missing).toEqual([]);
  });

  test("points at no deprecated voice", () => {
    const stale = ASSEMBLYAI_TTS_DEPRECATED_VOICES.filter((v) => guide.includes(`\`${v}\``));
    expect(stale).toEqual([]);
  });
});

/**
 * Same drift class as the voice catalog: the guide hand-restates SDK
 * defaults, so pin the restated numbers to the constants they quote.
 */
describe("scaffold guide SDK defaults", () => {
  test("quotes the real maxSteps default", () => {
    expect(scaffoldGuide).toContain(`default: ${DEFAULT_MAX_STEPS}`);
    expect(scaffoldGuide).toContain(`(default ${DEFAULT_MAX_STEPS})`);
  });

  test("quotes the real tool execution timeout", () => {
    expect(scaffoldGuide).toContain(
      `Tool execution timeout: ${TOOL_EXECUTION_TIMEOUT_MS / 1000} seconds`,
    );
  });
});

/**
 * The scaffold's pnpm settings only ever fail on a USER's machine, days after
 * anyone touched this repo — `aai init` runs the install, and a dropped or
 * misspelled key is silent (pnpm ignores unknown settings). So pin the two
 * that a scaffolded project cannot install without.
 */
describe("scaffold pnpm-workspace.yaml", () => {
  test("exempts our own packages from the release-age quarantine", () => {
    // Not `minimumReleaseAge: 0` — the exemption is deliberately scoped to
    // the packages `aai init` pins at `^<newest>`, leaving every third-party
    // dependency under whatever window the user configured.
    expect(scaffoldWorkspaceYaml).toMatch(/^minimumReleaseAgeExclude:\n\s+- "@alexkroman1\/\*"$/m);
    expect(scaffoldWorkspaceYaml).not.toMatch(/^minimumReleaseAge:/m);
  });

  test("keeps esbuild's build script approved under both pnpm 10 and 11", () => {
    // pnpm 10 reads `onlyBuiltDependencies`, pnpm 11 `allowBuilds`; whichever
    // one goes missing, the install fails on an unapproved build script.
    expect(scaffoldWorkspaceYaml).toMatch(/^onlyBuiltDependencies:\n\s+- esbuild$/m);
    expect(scaffoldWorkspaceYaml).toMatch(/^allowBuilds:\n\s+esbuild: true$/m);
  });
});
