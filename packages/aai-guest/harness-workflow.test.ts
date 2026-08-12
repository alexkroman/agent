// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the guest's workflow loading.
 *
 * The rewriting is what these are really about. It is the one piece here that
 * fails SILENTLY when it is subtly wrong — a specifier rewritten to a path that
 * does not exist, or one left bare that needed rewriting, both surface as
 * `ERR_MODULE_NOT_FOUND` from `/tmp` with nothing pointing back at this file.
 */

import { describe, expect, test } from "vitest";
import { loadStepBundle, rewriteWorkflowImports, webhookToken } from "./harness-workflow.ts";

describe("rewriteWorkflowImports", () => {
  test("rewrites a bare DevKit import to an absolute file URL", () => {
    const out = rewriteWorkflowImports(`import { sleep } from "workflow";\n`);
    expect(out).toMatch(/^import \{ sleep \} from "file:\/\/\//);
    expect(out).toContain("/workflow/");
  });

  test("rewrites every specifier the builder actually emits", () => {
    // Measured against real artifacts: the step bundle imports exactly
    // `workflow`, `workflow/internal/private` and `workflow/runtime`, and the
    // flow bundle only `workflow/runtime`. Everything else is inlined.
    for (const spec of ["workflow", "workflow/internal/private", "workflow/runtime"]) {
      const out = rewriteWorkflowImports(`import x from "${spec}";`);
      expect(out, spec).toMatch(/from "file:\/\/\//);
    }
  });

  test("rewrites a side-effect import, which is the shape the step bundle uses", () => {
    // `import "workflow/internal/private"` has no `from`, so a rewrite keyed
    // only on `from` would miss the one form that matters most here.
    const out = rewriteWorkflowImports(`import "workflow/internal/builtins";`);
    expect(out).toMatch(/^import "file:\/\/\//);
  });

  test("leaves the agent's own bundled imports alone", () => {
    // Everything but the DevKit is inlined by the builder, so a bare specifier
    // that is NOT the DevKit means a bundling bug — rewriting it would hide one.
    const code = `import a from "node:fs";\nimport b from "./local.js";\nimport c from "zod";`;
    expect(rewriteWorkflowImports(code)).toBe(code);
  });

  test("leaves a matching string that is not an import specifier alone", () => {
    // The transform emits step ids as string literals, and they contain the
    // word. A blunter replace would corrupt the registry keys.
    const code = `registerStepFunction("step//./workflows/x//go", go);`;
    expect(rewriteWorkflowImports(code)).toBe(code);
  });

  test("leaves an unresolvable specifier as-is rather than mangling it", () => {
    // `@workflow/*` is in the rewritable set defensively — the builder does not
    // emit one today, and those packages are not direct dependencies here. If it
    // ever starts, this is the behaviour that makes it diagnosable: the import
    // survives and fails at load with Node's own error naming the module, rather
    // than being rewritten to a path that resolves to nothing.
    const code = `import x from "@workflow/not-installed-here";`;
    expect(rewriteWorkflowImports(code)).toBe(code);
  });

  test("resolves the root entry the way an IMPORT does, not a require", async () => {
    // `workflow`'s root maps `require` to its TypeScript plugin, so resolving
    // with require semantics rewrites to a CJS module that dies on
    // `typescript/lib/tsserverlibrary`. Importing the rewritten URL is the only
    // assertion that catches it.
    const out = rewriteWorkflowImports(`import x from "workflow";`);
    const url = /"(file:\/\/[^"]+)"/.exec(out)?.[1];
    expect(url).toBeDefined();
    expect(url).not.toContain("typescript-plugin");
    await expect(import(url as string)).resolves.toBeDefined();
  });

  test("handles single quotes and irregular spacing", () => {
    const out = rewriteWorkflowImports(`import {a} from  'workflow/api'`);
    expect(out).toMatch(/from {2}'file:\/\/\//);
  });
});

describe("loadStepBundle", () => {
  test("evaluates the bundle, which is what registers its steps", async () => {
    // Registration is a top-level side effect and the module's exports are
    // never read, so evaluation IS the contract.
    const marker = `aai-step-load-${Date.now()}`;
    await loadStepBundle(`globalThis[${JSON.stringify(marker)}] = true;`);
    expect((globalThis as Record<string, unknown>)[marker]).toBe(true);
    delete (globalThis as Record<string, unknown>)[marker];
  });

  test("loads a bundle whose DevKit import had to be rewritten", async () => {
    // The end-to-end shape: a bare import that would fail from /tmp untouched.
    const marker = `aai-step-wdk-${Date.now()}`;
    await loadStepBundle(
      `import { sleep } from "workflow";\n` +
        `globalThis[${JSON.stringify(marker)}] = typeof sleep;`,
    );
    expect((globalThis as Record<string, unknown>)[marker]).toBe("function");
    delete (globalThis as Record<string, unknown>)[marker];
  });

  test("a second load of different code is not served from the module cache", async () => {
    const a = `aai-step-a-${Date.now()}`;
    const b = `aai-step-b-${Date.now()}`;
    await loadStepBundle(`globalThis[${JSON.stringify(a)}] = 1;`);
    await loadStepBundle(`globalThis[${JSON.stringify(b)}] = 2;`);
    // Node caches by URL, so a fixed temp path would silently serve the first
    // bundle for the rest of the process — which in the studio's build→load
    // loop means testing the code you just replaced.
    expect((globalThis as Record<string, unknown>)[b]).toBe(2);
    delete (globalThis as Record<string, unknown>)[a];
    delete (globalThis as Record<string, unknown>)[b];
  });
});

describe("webhookToken", () => {
  test("extracts the token from a webhook path", () => {
    expect(webhookToken("/.well-known/workflow/v1/webhook/abc123")).toBe("abc123");
  });

  test("percent-decodes it", () => {
    expect(webhookToken("/.well-known/workflow/v1/webhook/a%2Fb")).toBe("a/b");
  });

  test("rejects an empty trailing segment", () => {
    // A webhook URL is handed out of the system, so the token IS the
    // authorization; an empty one must not reach the DevKit as a lookup.
    expect(webhookToken("/.well-known/workflow/v1/webhook/")).toBeUndefined();
  });

  test("rejects a multi-segment tail rather than joining it", () => {
    expect(webhookToken("/.well-known/workflow/v1/webhook/a/b")).toBeUndefined();
  });

  test("returns undefined for any other path", () => {
    expect(webhookToken("/.well-known/workflow/v1/flow")).toBeUndefined();
    expect(webhookToken("/health")).toBeUndefined();
  });
});
