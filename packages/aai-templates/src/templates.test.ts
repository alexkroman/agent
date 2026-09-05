// Copyright 2025 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * Build-smoke test for every template.
 *
 * Imports each template's agent.ts (through the same import shapes the CLI
 * bundler supports — `?raw`-suffixed raw strings and `.json`, both native
 * to Vite/vitest) and runs the config through `toAgentConfig` +
 * `agentToolsToSchemas`, the exact validation path `aai build`/`aai deploy`
 * use (see packages/aai-cli/src/_bundler.ts).
 *
 * This catches, for every template — not just the ones the e2e tier builds:
 * - a renamed/missing asset import (system-prompt.md, knowledge.json)
 * - a config the manifest layer would reject (partial provider triple,
 *   invalid text-only tuning, bad silence policy)
 *
 * Deliberately config-level only: tool behavior belongs in each template's
 * own agent.test.ts.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type { AgentDef } from "@alexkroman1/aai";
import { DEFAULT_SYSTEM_PROMPT } from "@alexkroman1/aai";
import { ASSEMBLYAI_TTS_DEPRECATED_VOICES } from "@alexkroman1/aai/host-internal";
import { DEFAULT_MAX_STEPS, TOOL_EXECUTION_TIMEOUT_MS } from "@alexkroman1/aai/internal";
import { agentToolsToSchemas, toAgentConfig } from "@alexkroman1/aai/manifest";
import { ASSEMBLYAI_TTS_VOICES } from "@alexkroman1/aai/tts";
import { describe, expect, test } from "vitest";
import biomeConfig from "../../../biome.json?raw";
// `?raw` rather than node:fs — this package's tsconfig has no node types, and
// the raw-import shape is the one the CLI bundler supports anyway.
import scaffoldGuide from "../scaffold/CLAUDE.md?raw";
import scaffoldWorkspaceYaml from "../scaffold/pnpm-workspace.yaml?raw";
import { templatePromptFiles, withTemplatePrompt, withTemplateTools } from "./_discovery.ts";
import { byCodeUnit } from "./_template-support.ts";

/** What a template's default export must satisfy — derived from the exact
 * functions the CLI bundler feeds it to. */
type AgentDefLike = Parameters<typeof toAgentConfig>[0] & {
  tools?: Parameters<typeof agentToolsToSchemas>[0];
};

// Lazy glob: each agent.ts (and its asset imports) is only loaded inside its
// own test case, so one broken template fails one test, not collection.
const agentModules = import.meta.glob("../templates/*/agent.ts");

const templates = Object.keys(agentModules)
  .map((modulePath) => {
    // Key shape: "../templates/<name>/agent.ts"
    const name = modulePath.split("/")[2];
    if (!name) throw new Error(`Unexpected glob key: ${modulePath}`);
    return { name, modulePath };
  })
  .sort((a, b) => byCodeUnit(a.name, b.name));

describe("template build smoke", () => {
  test("discovers templates", () => {
    expect(templates.length).toBeGreaterThan(0);
  });

  /**
   * The prompt glob is checked against the FILESYSTEM, not against itself.
   *
   * `withTemplatePrompt` no-ops for a template with no `system-prompt.md`, so a
   * glob that stopped resolving would make every template look like that case
   * and the per-template assertion below would skip silently. A first attempt at
   * this guard derived the expected set from the same glob and was verified
   * NOT to bite: breaking the pattern changed nothing. Two independent sources
   * is the only shape that can catch it.
   */
  test("every system-prompt.md on disk is discovered", () => {
    const onDisk = templates
      .filter(({ name }) =>
        existsSync(path.join(import.meta.dirname, "..", "templates", name, "system-prompt.md")),
      )
      .map(({ name }) => name);
    expect(onDisk.length).toBeGreaterThan(0);
    expect([...templatePromptFiles].toSorted()).toEqual(onDisk.toSorted());
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
      // And the same tool resolution: a tool is registered by existing under
      // `tools/`, so schemas are checked against the resolved set rather than
      // the (now empty) map the definition itself carries. This is also what
      // asserts every tool file's name, shape and uniqueness — `toolRegistry`
      // throws naming the file, so a template's tools are validated here.
      const resolved = withTemplateTools(name, agentDef as AgentDef);
      expect(() => agentToolsToSchemas(resolved.tools)).not.toThrow();
      // And the prose half, for the same reason: `system-prompt.md` BECOMES the
      // prompt, so this is where an empty one — or one the agent ignores while
      // declaring its own — fails, for every template at once.
      const withPrompt = withTemplatePrompt(name, resolved);
      // A template WITH a file must actually be carrying its text. Asserting only
      // that the call does not throw would pass vacuously if the `?raw` glob ever
      // stopped resolving — the shape of failure this repo keeps paying for, a
      // gate reporting success while checking nothing.
      if (templatePromptFiles.has(name)) {
        expect(withPrompt.systemPrompt).not.toBe(DEFAULT_SYSTEM_PROMPT);
      }
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
  test("lists every current voice", () => {
    const missing = Object.keys(ASSEMBLYAI_TTS_VOICES).filter(
      (v) => !scaffoldGuide.includes(`\`${v}\``),
    );
    expect(missing).toEqual([]);
  });

  test("points at no deprecated voice", () => {
    const stale = ASSEMBLYAI_TTS_DEPRECATED_VOICES.filter((v) =>
      scaffoldGuide.includes(`\`${v}\``),
    );
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

  // Every build script the scaffold's dependency tree contains, declared under
  // BOTH key names. Asserted per package rather than as one exact block, so
  // adding a fourth does not have to reproduce the file's formatting.
  //
  // `@swc/core` and `cbor-extract` are the transitive ones, pulled in by
  // `workflow`. They were missing when the DevKit templates landed, and on
  // pnpm 11 an undeclared build script is a hard `ERR_PNPM_IGNORED_BUILDS`, so
  // `aai init` died at its own install step — a break that only reproduces
  // OUTSIDE this repo, which is why it reached main. The e2e suite is the one
  // tier that installs a scaffolded project for real, and it is what caught it.
  test.each(["@swc/core", "cbor-extract", "esbuild"])(
    "keeps %s's build script approved under both pnpm 10 and 11",
    (pkg) => {
      // pnpm 10 reads `onlyBuiltDependencies`, pnpm 11 `allowBuilds`; whichever
      // one goes missing, the install fails on an unapproved build script.
      const quoted = pkg.startsWith("@") ? `"${pkg}"` : pkg;
      expect(scaffoldWorkspaceYaml).toMatch(
        new RegExp(`^onlyBuiltDependencies:(\\n\\s+- .+)*\\n\\s+- ${quoted}$`, "m"),
      );
      expect(scaffoldWorkspaceYaml).toMatch(
        new RegExp(`^allowBuilds:(\\n\\s+.+)*\\n\\s+${quoted}: true$`, "m"),
      );
    },
  );
});

/**
 * The scaffold is LINTED, and it must stay that way.
 *
 * `biome.json` used to carry a negated scaffold glob in its `files.includes`
 * (spelled out in the assertion below rather than here, a literal one closing
 * this very comment), so every file `aai init` copies into a user's project was
 * checked by nothing — not the
 * per-package `biome check .`, not `pnpm lint`, not CI. It was inherited rather
 * than argued for: the exclusion arrived with the whole config file (#1159) and
 * no comment ever gave a reason.
 *
 * It cost a real bug. `scaffold/server.mjs` registered its SIGINT/SIGTERM
 * handler as an "async" listener, so a rejecting `server.close()` became an
 * unhandled rejection — a stack trace on Ctrl-C in every project ever
 * scaffolded. `guard-invariants` rule 23 found it because that gate scans the
 * whole tree; Biome's own `noMisusedPromises` could not, having been told not to
 * look. Removing the exclusion cost exactly one import-order fix.
 *
 * Asserted here rather than left to the linter itself for the reason this file
 * exists: a re-added exclusion makes the linter QUIETER, so nothing fails and
 * the loss is invisible. Note the scaffold ships to users, which makes it the
 * LAST place in the repo that should be unchecked.
 */
describe("scaffold is linted", () => {
  test("biome.json does not exclude it", () => {
    expect(biomeConfig).not.toMatch(/!\*\*\/scaffold/);
    // The positive half: `packages/**` is what pulls the scaffold in, so a
    // narrowed root pattern would exclude it just as effectively.
    expect(biomeConfig).toMatch(/"packages\/\*\*"/);
  });
});
