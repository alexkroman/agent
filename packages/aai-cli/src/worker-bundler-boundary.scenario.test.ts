// Copyright 2026 the AAI authors. MIT license.
/**
 * The bundle/runtime boundary, end to end through a REAL build: a worker bundle
 * carries its own copy of `@alexkroman1/aai`, and the host reads what that copy
 * made through its own copy — by registered brand, never by identity.
 *
 * Why a build and not a `vi.resetModules()` double: the premise under test is
 * what the bundler EMITS (the SDK inlined, no bare `@alexkroman1/aai` import
 * left for the host to satisfy), and only a real Vite pass says that. In-tree
 * the bundle resolves the package's `dist/` while this spec runs `src/` under
 * `@dev/source`, so the two copies are genuinely different modules. The design
 * is "The bundle/runtime boundary" in `packages/aai/CLAUDE.md`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolDef } from "@alexkroman1/aai";
import { readRouteResponse } from "@alexkroman1/aai/host-internal";
import { clientToolBrand } from "@alexkroman1/aai/internal";
import { FatalError } from "@alexkroman1/aai/step-errors";
import { createToolContext } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import { linkSdkNodeModules, withTempDir } from "./_test-utils.ts";
import { buildWorker } from "./worker-bundler.ts";

const AGENT = `import { agent } from "@alexkroman1/aai";\nexport default agent({ name: "Boundary" });\n`;

const TOOLS: Record<string, string> = {
  "where_am_i.ts": `import { clientTool } from "@alexkroman1/aai";
export default clientTool({ description: "the page answers", timeoutMs: 1234 });
`,
  "answer.ts": `import { routeResponse, tool } from "@alexkroman1/aai";
export default tool({ description: "a branded answer", execute: () => routeResponse(201, { ok: true }) });
`,
  "give_up.ts": `import { tool } from "@alexkroman1/aai";
import { FatalError } from "@alexkroman1/aai/step-errors";
export default tool({ description: "a branded throw", execute: () => { throw new FatalError("no"); } });
`,
};

async function buildAndLoad(
  dir: string,
): Promise<{ code: string; tools: Record<string, ToolDef> }> {
  await linkSdkNodeModules(dir);
  await fs.writeFile(path.join(dir, "agent.ts"), AGENT, "utf-8");
  await fs.mkdir(path.join(dir, "tools"));
  for (const [file, source] of Object.entries(TOOLS)) {
    await fs.writeFile(path.join(dir, "tools", file), source, "utf-8");
  }
  // The dev shape: no runtime inlined, so the HOST's runtime runs this bundle.
  const code = await buildWorker(dir, { runtime: false });
  const out = path.join(dir, "worker.mjs");
  await fs.writeFile(out, code, "utf-8");
  const mod = (await import(pathToFileURL(out).href)) as {
    default: { tools: Record<string, ToolDef> };
  };
  return { code, tools: mod.default.tools };
}

describe("the bundle/runtime boundary", () => {
  test("the bundle inlines its own SDK, and the host reads its brands", async () => {
    await withTempDir(async (dir) => {
      const { code, tools } = await buildAndLoad(dir);

      // The premise: nothing in the bundle asks the host for the SDK. Anchored
      // to a statement, because inlined doc comments quote example imports.
      expect(code).not.toMatch(/^\s*(?:import|export)\b[^\n]*["']@alexkroman1\/aai/m);
      expect(code).not.toMatch(/\bimport\(\s*["']@alexkroman1\/aai/);
      const whereAmI = tools.where_am_i;
      const answer = tools.answer;
      const giveUp = tools.give_up;
      if (!(whereAmI && answer && giveUp)) throw new Error("the bundle lost a tool");

      // A clientTool made by the bundle's copy, read by the host's.
      expect(clientToolBrand(whereAmI)).toEqual({ timeoutMs: 1234 });

      // A routeResponse made by the bundle's copy.
      const value = await answer.execute({}, createToolContext());
      expect(readRouteResponse(value)).toEqual({ status: 201, body: { ok: true } });

      // A FatalError thrown by the bundle's copy: the brand recognises it, and
      // `instanceof` — module identity — does not, which is why it is banned.
      let thrown: unknown;
      try {
        await giveUp.execute({}, createToolContext());
      } catch (err) {
        thrown = err;
      }
      expect(FatalError.is(thrown)).toBe(true);
      expect(thrown instanceof FatalError).toBe(false);
    });
  });
});
