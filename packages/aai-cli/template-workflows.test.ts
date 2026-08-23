// Copyright 2026 the AAI authors. MIT license.
/**
 * Every shipped template's `workflows/` directory has to BUILD.
 *
 * Nothing checked this, and two of the seven were broken. `pnpm typecheck`
 * type-checks a template's sources, `templates.test.ts` validates the config its
 * `agent.ts` declares, and neither runs the Workflow DevKit's transform — which
 * is the only thing that can answer the question this file asks: does the
 * workflow-mode bundle this project deploys actually load?
 *
 * `call-audit` and `transcription-workflow` both said no. Each held a
 * `classifyFfmpeg` beside its step, and that one module-scope reference to
 * `isFfmpegError` kept `@alexkroman1/aai/ffmpeg` — a module that spawns a child
 * process — inside a bundle compiled in a `node:vm` Script with no `require`. So
 * both templates deployed cleanly and then failed EVERY run at replay with
 * `ReferenceError: require is not defined`, pointing at a line of generated code
 * inside the SDK. A template is a starter somebody scaffolds and runs, so that
 * is the shipped product being broken, with every gate in the repo green.
 *
 * It lives in this package rather than in `aai-templates` because the builder
 * does: nothing but `aai-guest` may import from the CLI, and `eject.test.ts` and
 * `init.test.ts` already read `../aai-templates` the same way.
 *
 * Each template is built in a COPY under a temp directory. Building in place
 * writes into the project: an empty `.aai/` that `buildWorkflows` cleans only
 * one level of, and a `.gitignore` holding `/.swc` that the WDK builder writes
 * itself — both inside directories `bundle-templates.mjs` copies into the CLI
 * tarball. Observed, on the first draft of this file.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { linkSdkNodeModules, withTempDir } from "./_test-utils.ts";
import { findVmRequires } from "./_workflow-scan.ts";
import { buildWorkflows, WORKFLOWS_DIR } from "./workflow-bundler.ts";

const TEMPLATES = path.resolve(import.meta.dirname, "../aai-templates/templates");

/**
 * The fewest templates that may declare a workflow surface.
 *
 * A floor because this file's whole output is otherwise a count: a `readdir`
 * that stopped matching, or a rename of `templates/`, would build nothing and
 * report every template as passing. Eight today — `call-audit`, `link-digest`,
 * `podcast-digest`, `recap-workflow`, `redline`, `research-workflow`,
 * `spoken-summary`, `transcription-workflow`.
 */
const MIN_WORKFLOW_TEMPLATES = 8;

/**
 * Code-unit order, never `localeCompare` — with no explicit locale that answers
 * to the runtime's ICU default, so the same tree would name the cases in a
 * different order on a different machine. The repo's standing rule for anything
 * a gate reads.
 */
const byCodeUnit = (a: string, b: string): number => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

/** Templates that ship a `workflows/` directory, by name. */
async function workflowTemplates(): Promise<string[]> {
  const entries = await fs.readdir(TEMPLATES, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workflows = await fs
      .stat(path.join(TEMPLATES, entry.name, WORKFLOWS_DIR))
      .catch(() => undefined);
    if (workflows?.isDirectory()) found.push(entry.name);
  }
  return found.sort(byCodeUnit);
}

describe("every template's workflow surface builds", async () => {
  const names = await workflowTemplates();

  test("finds every template that declares one", () => {
    expect(names.length).toBeGreaterThanOrEqual(MIN_WORKFLOW_TEMPLATES);
  });

  // One case per template, so the reporter names the one that broke rather than
  // reporting "a template". The build is the assertion — `buildWorkflows`
  // throws on a Node builtin the workflow VM cannot answer for, and on any
  // ordinary compile error in a `workflows/` module — and `findVmRequires`
  // re-reads the artifact because the throw is what a future regression might
  // route around, not the property.
  test.each(names)("%s", { timeout: 120_000 }, async (name) => {
    await withTempDir(async (dir) => {
      const project = path.join(dir, name);
      // `node_modules` is FILTERED, and the filter is the fix rather than a
      // tidiness: a template directory somebody has run vite or `aai dev` in holds
      // one, copying it in makes `linkSdkNodeModules` a no-op, and the build then
      // fails on an unresolvable SDK import. The helper reports that now; not
      // copying it is what stops it happening.
      await fs.cp(path.join(TEMPLATES, name), project, {
        recursive: true,
        filter: (src) => path.basename(src) !== "node_modules",
      });
      await linkSdkNodeModules(project);
      const built = await buildWorkflows(project);
      expect(built?.workflowCode).toBeTruthy();
      expect(findVmRequires(built?.workflowCode ?? "")).toEqual([]);
    });
  });
});
