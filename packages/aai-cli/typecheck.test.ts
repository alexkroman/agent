// Copyright 2026 the AAI authors. MIT license.
// The build/deploy typecheck gate: projects with a tsconfig are checked
// with their own compiler; projects without one are skipped (they never
// declared a type discipline). Failures carry tsc's diagnostics — the
// message the studio's coding agent acts on.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { linkRootNodeModules, withTempDir } from "./_test-utils.ts";
import { typecheckProject } from "./typecheck.ts";

const TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
});

describe("typecheckProject", () => {
  test("skips projects without a tsconfig.json", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, "agent.ts"), "export default { name: 1 };");
      await expect(typecheckProject(dir)).resolves.toEqual({ ok: true, skipped: true });
    });
  });

  test("passes a well-typed project", { timeout: 60_000 }, async () => {
    await withTempDir(async (dir) => {
      await linkRootNodeModules(dir);
      await writeFile(path.join(dir, "tsconfig.json"), TSCONFIG);
      await writeFile(path.join(dir, "agent.ts"), "export const n: number = 1;\n");
      await expect(typecheckProject(dir)).resolves.toEqual({ ok: true, skipped: false });
    });
  });

  test("fails with tsc diagnostics on a type error", { timeout: 60_000 }, async () => {
    await withTempDir(async (dir) => {
      await linkRootNodeModules(dir);
      await writeFile(path.join(dir, "tsconfig.json"), TSCONFIG);
      await writeFile(path.join(dir, "agent.ts"), `export const n: number = "nope";\n`);
      const result = await typecheckProject(dir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.output).toContain("Type check failed");
        expect(result.output).toContain("agent.ts");
      }
    });
  });

  /**
   * Also the regression test for resolving TypeScript through Node's GLOBAL
   * paths. This temp dir has no `node_modules`, but vitest points `NODE_PATH`
   * at pnpm's hidden store — and Node appends `Module.globalPaths` to every
   * `require.resolve`, with no option to suppress them. So while the gate used
   * `require.resolve("typescript")` it found the repo's compiler from an
   * unrelated directory: this branch was unreachable, and a real user project
   * would have been checked with a compiler it never pinned. Keep the
   * resolution a walk-up (`findTypescriptPackage`), or this silently passes
   * again by typechecking against whatever TypeScript the host happens to have.
   */
  test("a tsconfig without an installed TypeScript is a loud failure", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, "tsconfig.json"), TSCONFIG);
      const result = await typecheckProject(dir);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.output).toContain("TypeScript is not installed");
    });
  });
});
