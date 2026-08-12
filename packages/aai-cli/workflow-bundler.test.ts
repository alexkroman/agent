// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for workflow bundling.
 *
 * These run the REAL builder against a real temp project, because every property
 * worth asserting here is a property of its output: that the directive transform
 * ran, that the Workflow DevKit stayed external (which is what keeps the
 * artifacts small enough to ride the guest's bundle), and that a project with no
 * workflows produces nothing rather than empty strings.
 *
 * A mocked builder could assert none of that — it would only restate the config
 * object, which is the part that has never been wrong.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { withTempDir } from "./_test-utils.ts";
import { buildWorkflows } from "./workflow-bundler.ts";

/**
 * Make `workflow` resolvable from the temp project, as a real one has it.
 *
 * Not incidental scaffolding: the WDK is marked EXTERNAL in both bundles, but
 * esbuild still resolves an external import to decide it is a package rather
 * than a relative path, and the discovery pass reads the module to check it for
 * directives. So a project that does not have it installed fails the build —
 * which is correct, and is why a scaffolded project declares it.
 */
async function linkWorkflowPackage(dir: string): Promise<void> {
  const resolved = path.resolve(
    import.meta.dirname,
    "..",
    "aai-templates",
    "node_modules",
    "workflow",
  );
  const target = path.join(dir, "node_modules", "workflow");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.symlink(resolved, target, "dir");
}

/** A minimal project with one workflow body and two steps. */
async function writeProject(dir: string): Promise<void> {
  await linkWorkflowPackage(dir);
  await fs.mkdir(path.join(dir, "workflows"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "workflows", "greet.ts"),
    `import { sleep } from "workflow";

export async function greetFlow(input: { name: string }) {
  "use workflow";
  const hello = await compose(input.name);
  await sleep("1s");
  return { text: await shout(hello) };
}

async function compose(name: string) {
  "use step";
  return \`hello \${name}\`;
}

async function shout(text: string) {
  "use step";
  return text.toUpperCase();
}
`,
    "utf-8",
  );
}

describe("buildWorkflows", () => {
  test("resolves undefined for a project with no workflows/ directory", async () => {
    await withTempDir(async (dir) => {
      // The common case: every voice agent that never reaches for a workflow.
      expect(await buildWorkflows(dir)).toBeUndefined();
    });
  });

  test("resolves undefined for an empty workflows/ directory", async () => {
    await withTempDir(async (dir) => {
      await fs.mkdir(path.join(dir, "workflows"), { recursive: true });
      // An author may create the directory before writing anything in it.
      expect(await buildWorkflows(dir)).toBeUndefined();
    });
  });

  test("ignores a workflows/ directory holding no source files", async () => {
    await withTempDir(async (dir) => {
      await fs.mkdir(path.join(dir, "workflows"), { recursive: true });
      await fs.writeFile(path.join(dir, "workflows", "notes.md"), "not code", "utf-8");
      expect(await buildWorkflows(dir)).toBeUndefined();
    });
  });

  test("transforms the workflow body and attaches its workflowId", async () => {
    await withTempDir(async (dir) => {
      await writeProject(dir);
      const built = await buildWorkflows(dir);
      expect(built).toBeDefined();
      // The id is what `ctx.workflows.start` reads off the body. Without the
      // transform there is no such property and every start rejects.
      expect(built?.workflowCode).toMatch(/workflowId\s*=\s*"workflow\/\/[^"]*greetFlow"/);
    });
  });

  test("rewrites step calls to the runtime hook rather than inlining their bodies", async () => {
    await withTempDir(async (dir) => {
      await writeProject(dir);
      const built = await buildWorkflows(dir);
      // This is the whole point of workflow mode: a step call becomes a lookup
      // against the event log, so a replay short-circuits it.
      expect(built?.workflowCode).toContain("WORKFLOW_USE_STEP");
      expect(built?.workflowCode).not.toContain("toUpperCase");
    });
  });

  test("registers each step function in the step bundle", async () => {
    await withTempDir(async (dir) => {
      await writeProject(dir);
      const built = await buildWorkflows(dir);
      // Step mode keeps the bodies intact and registers them by id; the guest
      // evaluates this bundle for exactly that side effect.
      expect(built?.stepCode).toContain("registerStepFunction");
      expect(built?.stepCode).toContain("toUpperCase");
    });
  });

  test("keeps the Workflow DevKit external, which is what keeps the bundles small", async () => {
    await withTempDir(async (dir) => {
      await writeProject(dir);
      const built = await buildWorkflows(dir);
      // Inlined instead, these measure 3.7 MB and 12 MB — neither can ride the
      // guest's single-ESM-string delivery. The guest resolves `workflow` from
      // its baked image, so the import must survive as an import.
      expect(built?.workflowCode).toMatch(/from\s*["']workflow\/runtime["']/);
      expect(built?.workflowCode.length).toBeLessThan(500_000);
      expect(built?.stepCode.length).toBeLessThan(500_000);
    });
  });

  test("reports the declared workflows in its manifest", async () => {
    await withTempDir(async (dir) => {
      await writeProject(dir);
      const built = await buildWorkflows(dir);
      // The studio's workflows card renders this, and it is the only
      // machine-readable list of what a project declares.
      expect(JSON.stringify(built?.manifest)).toContain("greetFlow");
    });
  });

  test("leaves no build output behind in the project", async () => {
    await withTempDir(async (dir) => {
      await writeProject(dir);
      await buildWorkflows(dir);
      // A studio workspace syncs back to the user, so build artifacts inside it
      // would reach their working tree.
      const scratch = path.join(dir, ".aai", "workflow-build");
      await expect(fs.stat(scratch)).rejects.toThrow();
    });
  });
});
