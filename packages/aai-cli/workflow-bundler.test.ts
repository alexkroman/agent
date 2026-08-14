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
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { withTempDir } from "./_test-utils.ts";
import { buildWorker } from "./worker-bundler.ts";
import { buildWorkflows } from "./workflow-bundler.ts";

/**
 * Symlink this package's node_modules into the fixture, the way `_build.test.ts`
 * does — it is what makes `workflow` and `@alexkroman1/aai` resolvable there.
 *
 * Not incidental scaffolding for the WDK half: it is marked EXTERNAL in both
 * bundles, but esbuild still resolves an external import to decide it is a
 * package rather than a relative path, and the discovery pass reads the module
 * to check it for directives. A project without it installed fails the build —
 * correctly, which is why a scaffolded project declares it.
 */
async function linkNodeModules(dir: string): Promise<void> {
  await fs.symlink(
    path.resolve(import.meta.dirname, "node_modules"),
    path.join(dir, "node_modules"),
    "dir",
  );
}

/** A minimal project with one workflow body and two steps. */
async function writeProject(dir: string): Promise<void> {
  await linkNodeModules(dir);
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

  // A real 7 MB bundle: undici and the builtin registry ride in behind the
  // one import, which is slow to build and is the point of the test.
  test("a step's CJS dependency still loads, rather than throwing on a dynamic require", {
    timeout: 60_000,
  }, async () => {
    await withTempDir(async (dir) => {
      await linkNodeModules(dir);
      await fs.mkdir(path.join(dir, "workflows"), { recursive: true });
      // The real case rather than a stand-in: `@alexkroman1/aai/tools` reaches
      // `host/ssrf.ts`, which imports **undici** — CJS, requiring `node:assert`
      // at module scope, which is the shape esbuild cannot statically rewrite.
      await fs.writeFile(
        path.join(dir, "workflows", "net.ts"),
        `import { webSearch } from "@alexkroman1/aai/tools";

export async function netFlow() {
  "use workflow";
  return await probe();
}

async function probe() {
  "use step";
  return typeof webSearch;
}
`,
        "utf-8",
      );
      const built = await buildWorkflows(dir);
      const code = built?.stepCode ?? "";

      // esbuild's shim reads `typeof require !== "undefined" ? require : …`,
      // so what has to be true is that a real `require` is DEFINED AHEAD of the
      // `var __require = …` initializer that reads it. Ordering is the whole
      // contract, and it is the half a load cannot check: which CJS modules
      // esbuild initializes eagerly depends on the graph, so in-tree — where
      // `@dev/source` resolves the SDK to TypeScript — this same bundle
      // imports cleanly with no shim at all, and only the published `dist`
      // reaches the throw. That asymmetry is why the e2e suite was the one
      // gate that caught it, and why this asserts the mechanism rather than a
      // symptom that does not reproduce here.
      const shim = code.indexOf("createRequire");
      const thrower = code.indexOf("var __require =");
      expect(shim).toBeGreaterThanOrEqual(0);
      expect(thrower).toBeGreaterThan(shim);
      expect(code).toContain("Dynamic require of");

      // And it still loads, which is the claim the ordering exists to support.
      const bundle = path.join(dir, "step-under-test.mjs");
      await fs.writeFile(bundle, code, "utf-8");
      await expect(import(pathToFileURL(bundle).href)).resolves.toBeDefined();
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

describe("the worker bundle carries the workflow artifacts", () => {
  test("exports the flow code and the step code, and not the manifest", async () => {
    await withTempDir(async (dir) => {
      await writeProject(dir);
      await fs.writeFile(
        path.join(dir, "agent.ts"),
        `import { agent } from "@alexkroman1/aai";\nexport default agent({ name: "T" });\n`,
        "utf-8",
      );
      const workflows = await buildWorkflows(dir);
      const worker = await buildWorker(dir, { runtime: false, workflows });

      // The guest's `bundle/load` takes ONE ESM string, so the compiled workflow
      // surface has to ride the worker as data rather than as sibling files.
      expect(worker).toContain("__aaiWorkflowCode");
      expect(worker).toContain("__aaiStepCode");
      // The manifest is deliberately NOT carried: nothing reads it, and it rode
      // every deploy artifact double-encoded. See `WorkflowBundleOutput`.
      expect(worker).not.toContain("__aaiWorkflowManifest");
    });
  });

  test("omits the exports entirely for a project with no workflows", async () => {
    await withTempDir(async (dir) => {
      await linkNodeModules(dir);
      await fs.writeFile(
        path.join(dir, "agent.ts"),
        `import { agent } from "@alexkroman1/aai";\nexport default agent({ name: "T" });\n`,
        "utf-8",
      );
      const worker = await buildWorker(dir, { runtime: false, workflows: undefined });
      // Absent rather than empty: the guest reads their presence as "this agent
      // has a workflow surface", and mounting routes for nothing is a bug.
      expect(worker).not.toContain("__aaiWorkflowCode");
    });
  });
});
