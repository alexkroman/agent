// Copyright 2026 the AAI authors. MIT license.

import { symlink } from "node:fs/promises";
import path from "node:path";
import type { AgentDef } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import { evalWorkerBundle } from "./_bundler.ts";
import {
  CONVENTIONS_ENTRY_ID,
  discoverConventions,
  generateConventionsEntry,
  redirectsToAgentEntry,
} from "./_conventions.ts";
import { createDevWorkerBuilder } from "./_dev-bundler.ts";
import { withTempDir, writeFiles } from "./_test-utils.ts";
import { buildWorker } from "./worker-bundler.ts";

describe("discoverConventions", () => {
  test("null without agent.ts, even when convention files exist", async () => {
    await withTempDir(async (dir) => {
      await writeFiles(dir, { "instructions.md": "Prompt." });
      expect(await discoverConventions(dir)).toBeNull();
    });
  });

  test("null when the directory uses no conventions", async () => {
    await withTempDir(async (dir) => {
      await writeFiles(dir, { "agent.ts": "export default {};" });
      expect(await discoverConventions(dir)).toBeNull();
    });
  });

  test("finds instructions.md, tools/*.ts and skills/*.md", async () => {
    await withTempDir(async (dir) => {
      await writeFiles(dir, {
        "agent.ts": "export default {};",
        "instructions.md": "Prompt.",
        "tools/lookup.ts": "export default {};",
        "tools/zeta.ts": "export default {};",
        "skills/file-expenses.md": "Body.",
      });
      const conv = await discoverConventions(dir);
      expect(conv?.instructionsPath).toBe(path.join(dir, "instructions.md"));
      expect(conv?.toolFiles.map((t) => t.name)).toEqual(["lookup", "zeta"]);
      expect(conv?.skillFiles.map((s) => s.name)).toEqual(["file-expenses"]);
    });
  });

  test("ignores helpers, tests, declarations and dotfiles in tools/", async () => {
    await withTempDir(async (dir) => {
      await writeFiles(dir, {
        "agent.ts": "export default {};",
        "tools/real.ts": "export default {};",
        "tools/_shared.ts": "export const x = 1;",
        "tools/real.test.ts": "",
        "tools/real.test-d.ts": "",
        "tools/types.d.ts": "",
        "tools/notes.md": "not a tool",
        "skills/_draft.md": "ignored",
      });
      const conv = await discoverConventions(dir);
      expect(conv?.toolFiles.map((t) => t.name)).toEqual(["real"]);
      expect(conv?.skillFiles).toEqual([]);
    });
  });

  test("rejects filenames that are not valid tool names", async () => {
    await withTempDir(async (dir) => {
      await writeFiles(dir, {
        "agent.ts": "export default {};",
        "tools/bad name.ts": "export default {};",
      });
      await expect(discoverConventions(dir)).rejects.toThrow(/Invalid convention filename/);
    });
  });
});

describe("generateConventionsEntry", () => {
  test("imports every discovered file and composes them", () => {
    const code = generateConventionsEntry("/p/agent.ts", {
      instructionsPath: "/p/instructions.md",
      toolFiles: [{ name: "lookup", path: "/p/tools/lookup.ts" }],
      skillFiles: [{ name: "file-expenses", path: "/p/skills/file-expenses.md" }],
    });
    expect(code).toContain(`import __agent from "/p/agent.ts";`);
    expect(code).toContain(`import __instructions from "/p/instructions.md";`);
    expect(code).toContain(`import * as __tool_0 from "/p/tools/lookup.ts";`);
    expect(code).toContain(`"lookup": __tool_0.default`);
    expect(code).toContain(`"file-expenses": __skill_0`);
    expect(code).toContain("applyAgentConventions(__agent,");
  });
});

describe("redirectsToAgentEntry", () => {
  const agentPath = "/p/agent.ts";

  test("matches the absolute build input (no importer)", () => {
    expect(redirectsToAgentEntry("/p/agent.ts", undefined, agentPath)).toBe(true);
  });

  test("matches relative imports of agent.ts, with and without extension", () => {
    expect(redirectsToAgentEntry("./agent.ts", "/p/__aai-entry.ts", agentPath)).toBe(true);
    expect(redirectsToAgentEntry("./agent", "/p/__aai-entry.ts", agentPath)).toBe(true);
  });

  test("never redirects the generated entry's own import (no recursion)", () => {
    expect(redirectsToAgentEntry("/p/agent.ts", CONVENTIONS_ENTRY_ID, agentPath)).toBe(false);
  });

  test("leaves other modules alone", () => {
    expect(redirectsToAgentEntry("./tools.ts", "/p/agent.ts", agentPath)).toBe(false);
    expect(redirectsToAgentEntry("zod", "/p/agent.ts", agentPath)).toBe(false);
    expect(redirectsToAgentEntry("/q/agent.ts", undefined, agentPath)).toBe(false);
  });
});

// ─── End-to-end through the real bundlers ───────────────────────────────────
//
// These bundle a real project dir (node_modules symlinked in, like
// _dev-bundler.test.ts) and evaluate the worker, so they cover the whole
// convention path: discovery → generated entry → merge inside the bundle.
// They resolve @alexkroman1/aai via its `import` condition, i.e. dist/ —
// build the SDK first (same requirement as the studio bundle tests).

const CONVENTION_PROJECT = {
  "agent.ts": `import { agent } from "@alexkroman1/aai";
export default agent({ name: "Conventions E2E" });`,
  "instructions.md": "Answer in one word.",
  "tools/lookup.ts": `import { tool } from "@alexkroman1/aai";
export default tool({ description: "Look something up", execute: () => "found-it" });`,
  "skills/file-expenses.md": `---
description: How to file expenses
---
Step 1: open the portal.`,
};

async function linkNodeModules(dir: string): Promise<void> {
  await symlink(path.resolve(import.meta.dirname, "node_modules"), path.join(dir, "node_modules"));
}

/** Everything the composition should have produced, as one comparable value. */
async function composedSummary(def: AgentDef): Promise<Record<string, unknown>> {
  const ctx = {} as Parameters<NonNullable<AgentDef["tools"]>[string]["execute"]>[1];
  return {
    name: def.name,
    systemPrompt: def.systemPrompt,
    toolNames: Object.keys(def.tools ?? {}).sort(),
    skillDescription: def.tools?.skill_file_expenses?.description,
    lookupResult: await def.tools?.lookup?.execute({}, ctx),
    skillResult: await def.tools?.skill_file_expenses?.execute({}, ctx),
  };
}

const COMPOSED_EXPECTED = {
  name: "Conventions E2E",
  systemPrompt: "Answer in one word.",
  toolNames: ["lookup", "skill_file_expenses"],
  skillDescription: 'Load the "file-expenses" skill: How to file expenses',
  lookupResult: "found-it",
  skillResult: "Step 1: open the portal.",
};

describe("conventions through the deploy bundler (Vite)", () => {
  test("buildWorker composes instructions, tools and skills", async () => {
    await withTempDir(async (dir) => {
      await linkNodeModules(dir);
      await writeFiles(dir, CONVENTION_PROJECT);
      const def = await evalWorkerBundle(await buildWorker(dir), dir);
      expect(await composedSummary(def)).toEqual(COMPOSED_EXPECTED);
    });
  }, 60_000);

  test("a custom entry importing ./agent.ts sees the composed definition (studio parity)", async () => {
    await withTempDir(async (dir) => {
      await writeFiles(dir, {
        ...CONVENTION_PROJECT,
        "wrapper-entry.ts": `import def from "./agent.ts";\nexport default def;`,
      });
      await linkNodeModules(dir);
      const code = await buildWorker(dir, { entry: "wrapper-entry.ts", configFile: false });
      const def = await evalWorkerBundle(code, dir);
      expect(await composedSummary(def)).toEqual(COMPOSED_EXPECTED);
    });
  }, 60_000);

  test("a directory without convention files builds exactly as before", async () => {
    await withTempDir(async (dir) => {
      await linkNodeModules(dir);
      await writeFiles(dir, { "agent.ts": CONVENTION_PROJECT["agent.ts"] });
      const def = await evalWorkerBundle(await buildWorker(dir), dir);
      expect(def.name).toBe("Conventions E2E");
      expect(Object.keys(def.tools ?? {})).toEqual([]);
    });
  }, 60_000);
});

describe("conventions through the dev bundler (Rolldown)", () => {
  test("createDevWorkerBuilder composes instructions, tools and skills", async () => {
    await withTempDir(async (dir) => {
      await linkNodeModules(dir);
      await writeFiles(dir, CONVENTION_PROJECT);
      const builder = createDevWorkerBuilder(dir);
      try {
        const def = await evalWorkerBundle(await builder.build(), dir);
        expect(await composedSummary(def)).toEqual(COMPOSED_EXPECTED);
      } finally {
        await builder.dispose();
      }
    });
  }, 60_000);

  test("a convention file added between builds is picked up (watcher restart path)", async () => {
    await withTempDir(async (dir) => {
      await linkNodeModules(dir);
      await writeFiles(dir, { "agent.ts": CONVENTION_PROJECT["agent.ts"] });
      const builder = createDevWorkerBuilder(dir);
      try {
        const before = await evalWorkerBundle(await builder.build(), dir);
        expect(Object.keys(before.tools ?? {})).toEqual([]);

        await writeFiles(dir, { "tools/lookup.ts": CONVENTION_PROJECT["tools/lookup.ts"] });
        const after = await evalWorkerBundle(await builder.build(), dir);
        expect(Object.keys(after.tools ?? {})).toEqual(["lookup"]);
      } finally {
        await builder.dispose();
      }
    });
  }, 60_000);
});
