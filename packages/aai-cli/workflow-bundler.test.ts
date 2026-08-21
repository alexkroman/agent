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
import { linkSdkNodeModules, withTempDir } from "./_test-utils.ts";
import { buildWorker } from "./worker-bundler.ts";
import { buildWorkflows, findVmRequires } from "./workflow-bundler.ts";

/**
 * A minimal project with one workflow body and two steps.
 *
 * `linkSdkNodeModules` is not incidental scaffolding for the WDK half: the
 * `workflow` package is marked EXTERNAL in both bundles, but esbuild still
 * resolves an external import to decide it is a package rather than a relative
 * path, and the discovery pass reads the module to check it for directives. A
 * project without it installed fails the build — correctly, which is why a
 * scaffolded project declares it.
 */
async function writeProject(dir: string): Promise<void> {
  await linkSdkNodeModules(dir);
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
      await linkSdkNodeModules(dir);
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

/**
 * A project whose `workflows/` module reaches a Node builtin THROUGH A PACKAGE,
 * with the import written across several lines.
 *
 * Every detail here is load-bearing, and together they are the deployed shape
 * that `createNodeModuleErrorPlugin` cannot see:
 *
 * - the builtin is imported by a file under `node_modules`, so the plugin
 *   attributes the violation to the package rather than to a source line;
 * - `node_modules` is a REAL directory holding a real package, not a symlink
 *   into the workspace — esbuild resolves realpaths, so a workspace package
 *   linked in looks first-party and IS reported;
 * - the import in `flow.ts` spans lines, which the plugin's single-line
 *   location regex does not match, so it reports nothing and marks the builtin
 *   external in silence;
 * - `classify` is an ordinary export, so workflow mode keeps it and its
 *   import — only a `"use step"` body is removed.
 */
async function writeSilentBuiltinProject(dir: string): Promise<void> {
  const modules = path.join(dir, "node_modules");
  await fs.mkdir(path.join(modules, "spawner"), { recursive: true });
  // Only the WDK has to resolve; it is external in both bundles, but esbuild
  // still resolves it to decide it is a package.
  for (const dep of ["workflow", "@workflow"]) {
    await fs.symlink(
      path.join(import.meta.dirname, "node_modules", dep),
      path.join(modules, dep),
      "dir",
    );
  }
  await fs.writeFile(
    path.join(modules, "spawner", "package.json"),
    JSON.stringify({ name: "spawner", version: "1.0.0", type: "module", main: "index.js" }),
    "utf-8",
  );
  await fs.writeFile(
    path.join(modules, "spawner", "index.js"),
    `import { spawn } from "node:child_process";

export function isSpawnError(err) {
  return err instanceof Error;
}

export function run(cmd) {
  return spawn(cmd);
}
`,
    "utf-8",
  );
  await fs.mkdir(path.join(dir, "workflows"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "workflows", "flow.ts"),
    `import {
  isSpawnError,
  run,
} from "spawner";

export async function mainFlow() {
  "use workflow";
  return await work();
}

async function work() {
  "use step";
  return run("ls");
}

export function classify(err: unknown): boolean {
  return isSpawnError(err);
}
`,
    "utf-8",
  );
}

describe("findVmRequires", () => {
  test("names the builtin and the module esbuild attributed it to", () => {
    const found = findVmRequires(
      [
        "// node_modules/@alexkroman1/aai/dist/host/ffmpeg.js",
        'var import_node_child_process = require("node:child_process");',
      ].join("\n"),
    );
    expect(found).toEqual([
      {
        specifier: "node:child_process",
        module: "node_modules/@alexkroman1/aai/dist/host/ffmpeg.js",
      },
    ]);
  });

  test("passes a bundle that requires nothing, which every healthy build is", () => {
    // The five templates with a `workflows/` directory and no ffmpeg in it all
    // measure zero here, so this is the normal case rather than a lucky one.
    expect(findVmRequires("// workflows/flow.ts\nasync function mainFlow() {}\n")).toEqual([]);
  });

  test("ignores esbuild's own __require shim and any non-builtin specifier", () => {
    // The shim is the STEP bundle's mechanism (see `STEP_REQUIRE_SHIM`) and a
    // bare package name cannot reach this bundle — the builder marks nothing
    // external but builtins, so flagging one would be a false report.
    const code = [
      'var __require = typeof require !== "undefined" ? require : (x) => { throw x; };',
      '__require("node:assert");',
      'const dynamic = require("some-package");',
    ].join("\n");
    expect(findVmRequires(code)).toEqual([]);
  });
});

describe("the flow bundle may not require anything", () => {
  test("fails the build, naming the builtin and the module that reached it", {
    timeout: 60_000,
  }, async () => {
    await withTempDir(async (dir) => {
      await writeSilentBuiltinProject(dir);
      // Without this check the build SUCCEEDS here — reproduced — and every run
      // of every workflow in the project then dies at replay with
      // `ReferenceError: require is not defined`, from a line of generated code
      // inside a dependency. A deploy is the earliest anyone finds out.
      const failure = await buildWorkflows(dir).catch((err: unknown) => err as Error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("node:child_process");
      expect((failure as Error).message).toContain("node_modules/spawner/index.js");
      // The remedy, not just the diagnosis: the author's file holds the import
      // at module scope and nothing in the stack trace would say so.
      expect((failure as Error).message).toContain('"use step"');
    });
  });

  test("accepts the same project once the import is only a step body's", {
    timeout: 60_000,
  }, async () => {
    await withTempDir(async (dir) => {
      await writeSilentBuiltinProject(dir);
      // The one-line fix this gate exists to force: drop the export that holds
      // the package at module scope, and the transform drops the import with
      // the body it belongs to.
      const flow = path.join(dir, "workflows", "flow.ts");
      const source = await fs.readFile(flow, "utf-8");
      await fs.writeFile(
        flow,
        source.slice(0, source.indexOf("export function classify")),
        "utf-8",
      );
      const built = await buildWorkflows(dir);
      expect(findVmRequires(built?.workflowCode ?? "")).toEqual([]);
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
      await linkSdkNodeModules(dir);
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
