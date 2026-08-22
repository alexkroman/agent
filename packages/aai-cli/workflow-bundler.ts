// Copyright 2026 the AAI authors. MIT license.
/**
 * Workflow bundling — turning a project's `workflows/` directory into the two
 * small artifacts a guest needs to run durable workflows.
 *
 * Public (no `_` prefix) for the same reason as `worker-bundler.ts`: the studio
 * builds its workspaces through this too, so a workflow published from the
 * browser comes out of the same pass as one from `aai build`.
 *
 * @internal — build hook for aai-server/the studio; not a supported public API
 * and not covered by semver.
 *
 * ## Why this exists at all
 *
 * The Workflow Development Kit's own integrations (Next, Nitro, SvelteKit) build
 * workflow routes while building the SERVER, by scanning `workflows/` and
 * emitting handler files. That model does not fit this platform: the guest image
 * is baked once and then serves MANY tenants' agents, each arriving over
 * `bundle/load` at runtime. There is no `workflows/` directory in existence when
 * the harness is built. So the transform has to happen per tenant at deploy
 * time — here — and the guest receives the result as data.
 *
 * ## The two artifacts, and why they are small
 *
 * A default `workflow build` emits a 3.7 MB flow bundle and a 12 MB step bundle,
 * because each one inlines the whole WDK runtime. Neither could ride the guest's
 * single-ESM-string delivery. Two settings fix that, and both are load-bearing:
 *
 * - **`externalPackages: ["workflow", …]`** — the WDK is resolved from the
 *   guest's BAKED image instead of being inlined. Step bundle: 12 MB → ~7 KB.
 * - **`bundleFinalOutput: false`** — skips wrapping the workflow-mode code in a
 *   runtime host, which is exactly what `workflowEntrypoint(code)` supplies
 *   itself at the other end. Dialog bundle: 3.7 MB → ~69 KB.
 *
 * So `workflowCode` is passed to `workflowEntrypoint()` in the guest and
 * `stepCode` is evaluated there to register its step functions.
 *
 * ## The THIRD transform, which is the agent bundle's
 *
 * Those two are what the queue runs. The agent bundle needs a third —
 * `applySwcTransform(…, "client")`, wired in as {@link workflowClientPlugin} —
 * and without it the whole mechanism is inert: `ctx.workflows.start` reads the
 * `workflowId` the compiler attaches to a directive body, and Vite bundling
 * `workflows/research.ts` the ordinary way attaches nothing. The symptom is
 * `MISSING_WORKFLOW_ID_MESSAGE` at the first `start()` — an agent that builds,
 * deploys, boots and answers the phone, and cannot start a run.
 *
 * The plugin transforms EXACTLY the files the builder scanned (`inputFiles`),
 * not "every file with a directive". Same list, same `moduleSpecifierRoot`,
 * therefore the same ids by construction — a body outside `workflows/` cannot
 * acquire an id that no flow bundle registered, which would trade a clear
 * failure at `start()` for a run that enqueues and then fails at replay.
 *
 * ## Config details that are not optional
 *
 * Each of these cost real time to find, and none fails in a way that names
 * itself:
 *
 * - `dirs` must carry the `./` prefix. A bare `"workflows"` crashes inside
 *   enhanced-resolve with `Cannot read properties of undefined (reading
 *   'length')` from `join(undefined, …)`, nowhere near the cause.
 * - Every bundle path must be ABSOLUTE, for the same reason.
 * - `projectRoot` and `moduleSpecifierRoot` must be set explicitly; they do not
 *   default to `workingDir` on the path this takes.
 * - `keepInterimBundleContext` must stay off — it leaves an esbuild watch context
 *   alive, so a one-shot build never exits.
 */

import fs from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import {
  applySwcTransform,
  BaseBuilder,
  detectWorkflowPatterns,
  shouldTransformFile,
} from "@workflow/builders";
import type { Plugin } from "vite";

/**
 * The directory a project's `"use workflow"` bodies live in.
 *
 * The WDK builder's convention, not ours, and it is why a workflow body cannot
 * live in `agent.ts`: only files under here are transformed. A body outside it
 * runs inline, once, with no durability and nothing reporting that.
 */
export const WORKFLOWS_DIR = "workflows";

/**
 * Packages left OUT of both bundles, resolved from the guest's baked image.
 *
 * `workflow` alone would nearly do it — its subpaths are what user code imports —
 * but the `@workflow/*` internals are what the transform's own emitted imports
 * reach for, and inlining those is most of the 12 MB.
 */
const WDK_EXTERNAL = [
  "workflow",
  "@workflow/core",
  "@workflow/errors",
  "@workflow/utils",
  "@workflow/world",
] as const;

/** Scratch directory for the builder's file output, under the CLI's own dot-dir. */
const SCRATCH_REL = path.join(".aai", "workflow-build");

/**
 * What makes a CJS dependency survive into the ESM step bundle.
 *
 * esbuild cannot statically rewrite `require("node:assert")` inside a bundled
 * CommonJS module, so it emits a `__require` shim — and that shim's fallback
 * THROWS: `Dynamic require of "node:assert" is not supported`. A step bundles
 * everything it imports and npm is full of CJS, so any step reaching a package
 * with a CJS dependency anywhere in its graph failed AT MODULE LOAD, before a
 * single line of the step ran.
 *
 * That is not a hypothetical, and the way it presents is the argument for
 * fixing it here. `research-workflow` imports `webSearch` from
 * `@alexkroman1/aai/tools`, which reaches `host/ssrf.ts`, which imports
 * **undici** — 118 dynamic requires, all of them `node:` builtins. `aai dev`
 * then never listened at all: the message named a Node builtin the author
 * never mentions, nothing named the package or the import that pulled it, and
 * because the step bundle is loaded before the server binds there was no
 * server to ask. It also does not reproduce in-tree, where `@dev/source`
 * resolves the SDK to TypeScript — only against the published `dist` — so
 * every gate short of the e2e suite was green.
 *
 * The shim itself is the fix's whole mechanism: esbuild writes
 * `typeof require !== "undefined" ? require : <thrower>`, so a real `require`
 * in scope is USED. This defines one from `import.meta.url` and is prepended,
 * which puts it ahead of the `var __require = …` initializer that reads it.
 * The flow bundle deliberately gets none — it is compiled in a `node:vm`
 * Script, where `import.meta` does not exist.
 */
const STEP_REQUIRE_SHIM = [
  'import { createRequire as __aaiCreateRequire } from "node:module";',
  "const require = __aaiCreateRequire(import.meta.url);",
  "",
].join("\n");

/**
 * Every Node builtin, in both spellings esbuild can emit for one.
 *
 * `node:child_process` and bare `child_process` are the same module and the
 * bundle may name it either way — a bare name only reaches the output when the
 * source imported it bare, which npm is still full of.
 */
const RUNTIME_MODULES: ReadonlySet<string> = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

/**
 * A `require(…)` CALL, excluding esbuild's own `__require` shim.
 *
 * The lookbehind is what separates the two: `__require` is the shim esbuild
 * writes for a bundled CJS module's dynamic requires, and the STEP bundle
 * defines a real `require` for it (see {@link STEP_REQUIRE_SHIM}). A bare
 * `require` in the FLOW bundle is the different thing this scan is for.
 */
const REQUIRE_CALL = /(?<![\w$.])require\(\s*"([^"]+)"\s*\)/g;

/** esbuild's per-module header — `// node_modules/pkg/index.js`, and nothing else. */
const MODULE_COMMENT = /^\/\/ (\S+\.[cm]?[jt]sx?)$/;

/** One `require` the workflow VM cannot answer, and the module it was written for. */
export type VmRequireSite = {
  /** The module specifier — `node:child_process`. */
  specifier: string;
  /** The bundled file esbuild attributed it to, or `undefined` when it said none. */
  module: string | undefined;
};

/**
 * Find the Node builtins a flow bundle would `require` at load.
 *
 * The flow bundle is compiled in a `node:vm` `Script` whose context has
 * `module` and `exports` and **no `require`**, so one of these is a run that
 * dies at replay with `ReferenceError: require is not defined` — never a build
 * failure, and never a symptom before the first run. The WDK's own builder
 * bundles everything for exactly this reason and carries
 * `createNodeModuleErrorPlugin` to reject a builtin import at build time.
 *
 * That plugin has two blind spots this scan covers, and both are the DEPLOYED
 * shape rather than an exotic one:
 *
 * - It reports a violation only when it can point at the import LINE in a
 *   first-party file, matched with a single-line regex — so a multi-line
 *   `import {\n  x,\n} from "pkg"` finds nothing and the builtin is marked
 *   external in silence.
 * - It resolves that file against `process.cwd()`, which is not the project
 *   being built when the studio builds a workspace, so the read fails and the
 *   same silent path is taken.
 *
 * Both were reproduced. What reaches the VM either way is
 * `var import_node_child_process = require("node:child_process");` at the top
 * of the bundle, i.e. every run of every workflow in the project fails, and the
 * stack names a line of generated code inside a dependency.
 *
 * Restricted to builtin specifiers deliberately: those are the only ones this
 * builder leaves external (it marks nothing else so, precisely so nothing can
 * need a `require`), and a narrow set is what keeps the scan from reading the
 * text of a prompt as a violation.
 *
 * @internal
 */
export function findVmRequires(workflowCode: string): VmRequireSite[] {
  const found: VmRequireSite[] = [];
  const seen = new Set<string>();
  let module: string | undefined;
  for (const line of workflowCode.split("\n")) {
    const header = MODULE_COMMENT.exec(line.trim());
    if (header) {
      module = header[1];
      continue;
    }
    for (const [, specifier] of line.matchAll(REQUIRE_CALL)) {
      if (specifier === undefined || !RUNTIME_MODULES.has(specifier)) continue;
      // A NUL separates the two halves (neither can contain one, so the key
      // cannot collide) and is spelled as an ESCAPE, never the raw byte: one
      // control character makes a file binary to `git grep`, and every ratchet
      // here is a `git grep`. See "Never write a control character" in AGENTS.md.
      const key = `${specifier}\u0000${module ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ specifier, module });
    }
  }
  return found;
}

/**
 * Fail the build when the flow bundle carries a `require` — see
 * {@link findVmRequires} for what that means and why nothing upstream catches it.
 *
 * The message has to name the MODULE as well as the specifier, because the
 * import that caused it is not in the file an author is looking at: only a
 * `"use step"` body is stripped from this bundle, so a value a `workflows/`
 * module holds at module scope — an exported helper, a constant — keeps its
 * import, and that import's whole graph rides into the VM.
 */
function assertNoVmRequires(workflowCode: string): void {
  const sites = findVmRequires(workflowCode);
  if (sites.length === 0) return;
  const lines = sites.map(
    ({ specifier, module }) => `  ${specifier}${module === undefined ? "" : ` — from ${module}`}`,
  );
  throw new Error(
    [
      "This project's workflows cannot run: the workflow bundle requires " +
        `${sites.length === 1 ? "a Node module" : "Node modules"} that the workflow VM has no ` +
        "`require` for.",
      ...lines,
      "",
      'Only a `"use step"` body is removed from this bundle, so anything a `workflows/` ' +
        "module holds at MODULE scope keeps its import — including an exported helper that " +
        "a step body is the only caller of. Move that use inside the step body, or into a " +
        "module only a step body imports.",
    ].join("\n"),
  );
}

/** What a guest needs to serve workflows for one agent. */
export type WorkflowBundleOutput = {
  /**
   * The workflow-mode transform of every `"use workflow"` body, as code.
   *
   * Passed to `workflowEntrypoint(code)` in the guest — which is why it is a
   * STRING rather than a file: the guest never sees this project's filesystem.
   */
  workflowCode: string;
  /**
   * The step-mode transform, as code. Evaluated in the guest so its
   * `registerStepFunction` calls run; nothing imports anything from it.
   */
  stepCode: string;
  /**
   * The builder's manifest — `workflowId` per exported workflow, plus the step
   * graph. The ids are what `ctx.workflows.start` needs, and the SDK reads them
   * off each body's own `workflowId` property, so nothing consumes this at
   * runtime; it is the builder's own output, kept for inspection and asserted
   * by this package's spec.
   *
   * It is deliberately NOT emitted into the worker bundle. It was, as a
   * double-encoded `__aaiWorkflowManifest` string literal, on the stated
   * grounds that "the studio's workflows card renders it" — which was never
   * true (the card calls `GET /workflows`). Nothing anywhere read the export,
   * so it was bytes in every deploy artifact, re-fetched and hash-verified on
   * every cold guest boot, for no reader.
   */
  manifest: unknown;
  /**
   * The absolute paths the builder scanned — the agent bundle's client
   * transform runs over exactly these. See the module doc's third-transform
   * section for why it is this list and not a content sniff.
   */
  inputFiles: readonly string[];
};

/**
 * The builder, with the config gotchas above applied once.
 *
 * `BaseBuilder` is abstract over `build()`, so a subclass is the supported way to
 * choose which bundles to emit and how — the WDK's own framework integrations do
 * the same.
 */
class AaiWorkflowBuilder extends BaseBuilder {
  /**
   * Where `build()` leaves its result.
   *
   * `BaseBuilder.build()` is typed `Promise<void>`, so a subclass cannot return
   * the artifacts from it — and parameter properties are unavailable under this
   * repo's `erasableSyntaxOnly`, so the fields are declared the long way too.
   */
  output: WorkflowBundleOutput | undefined;
  /**
   * The two bundles `build()` reads back.
   *
   * Held as fields because `super()` is also told where to write them: derived
   * a second time inside `build()`, the two spellings of each path were free to
   * disagree, and a `build()` reading a file the builder never wrote is a
   * "produced nothing" failure that names neither path.
   */
  private readonly flowFile: string;
  private readonly stepFile: string;

  constructor(cwd: string, outDir: string) {
    const flowFile = path.join(outDir, "flow.mjs");
    const stepFile = path.join(outDir, "step.mjs");
    super({
      buildTarget: "standalone",
      dirs: [`./${WORKFLOWS_DIR}`],
      workingDir: cwd,
      projectRoot: cwd,
      moduleSpecifierRoot: cwd,
      externalPackages: [...WDK_EXTERNAL],
      stepsBundlePath: stepFile,
      workflowsBundlePath: flowFile,
      webhookBundlePath: path.join(outDir, "webhook.mjs"),
      // The builder narrates each bundle at info level, which is noise inside
      // `aai build` and actively wrong inside `aai dev`'s watch loop.
      suppressCreateWorkflowsBundleLogs: true,
      suppressCreateWebhookBundleLogs: true,
      suppressCreateManifestLogs: true,
    });
    this.flowFile = flowFile;
    this.stepFile = stepFile;
  }

  override async build(): Promise<void> {
    const inputFiles = await this.getInputFiles();

    const { manifest } = await this.createWorkflowsBundle({
      inputFiles,
      format: "esm",
      outfile: this.flowFile,
      // See the module doc — this is the 3.7 MB → 69 KB setting.
      bundleFinalOutput: false,
    });
    await this.createStepsBundle({ inputFiles, format: "esm", outfile: this.stepFile });

    const [workflowCode, stepCode] = await Promise.all([
      fs.readFile(this.flowFile, "utf-8"),
      fs.readFile(this.stepFile, "utf-8"),
    ]);
    // Before the artifacts are handed back, because the alternative is a deploy
    // that succeeds and a run that dies at replay — see `findVmRequires`.
    assertNoVmRequires(workflowCode);
    this.output = { workflowCode, stepCode: STEP_REQUIRE_SHIM + stepCode, manifest, inputFiles };
  }
}

/**
 * Attach the compiler's `workflowId`/`stepId` to the agent bundle's copy of
 * each directive body — the third transform, see the module doc.
 *
 * `enforce: "pre"` so it sees the file before Vite's own TypeScript pass: the
 * swc transform reads types itself (it is given the filename to infer syntax),
 * and its output is plain JS that the later pass leaves alone.
 *
 * @internal
 */
export function workflowClientPlugin(cwd: string, inputFiles: readonly string[]): Plugin {
  // Resolved once: Vite hands `transform` an id that may carry a query suffix
  // and, on Windows, a different separator, so the comparison is against
  // normalized absolute paths rather than the strings the builder produced.
  const scanned = new Set(inputFiles.map((file) => path.resolve(cwd, file)));

  return {
    name: "aai:workflow-client",
    enforce: "pre",
    async transform(code: string, id: string) {
      const file = path.resolve(id.split("?")[0] ?? id);
      if (!scanned.has(file)) return;
      // A scanned file need not hold a directive — `workflows/types.ts` beside
      // the bodies is ordinary code, and running the transform over it would
      // strip its types for no reason.
      if (!shouldTransformFile(file, detectWorkflowPatterns(code))) return;

      const { code: transformed } = await applySwcTransform(
        // The RELATIVE path, because it is what the id is derived from — the
        // absolute one would put this machine's home directory inside a
        // workflowId, and the flow bundle (built with the same
        // `moduleSpecifierRoot`) would then register a different id.
        path.relative(cwd, file),
        code,
        "client",
        file,
        cwd,
        cwd,
      );
      // No source map: the transform returns none, and inventing an identity
      // map would claim line fidelity the stubbed body does not have.
      return { code: transformed, map: null };
    },
  };
}

/**
 * Build a project's workflows, or resolve `undefined` when it declares none.
 *
 * `undefined` rather than empty strings, because "this project has no workflows"
 * is the common case — every voice agent that never reaches for one — and the
 * guest must be able to tell it apart from "the build produced nothing", which
 * would be a bug.
 *
 * @internal
 */
export async function buildWorkflows(cwd: string): Promise<WorkflowBundleOutput | undefined> {
  if (!(await hasWorkflowsDir(cwd))) return;

  const outDir = path.join(cwd, SCRATCH_REL);
  await fs.mkdir(outDir, { recursive: true });
  try {
    const builder = new AaiWorkflowBuilder(cwd, outDir);
    await builder.build();
    const built = builder.output;
    if (!built) return;
    // A `workflows/` directory holding no directive is not an error — an author
    // may have created it before writing anything — but it must not be reported
    // as a built workflow surface either, or the guest mounts routes for nothing.
    return built.workflowCode.trim() === "" ? undefined : built;
  } finally {
    // The artifacts are returned as strings; leaving them on disk would put
    // build output inside a studio workspace, which then syncs back to the user.
    await fs.rm(outDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Does this project have a `workflows/` directory with anything in it? */
async function hasWorkflowsDir(cwd: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(path.join(cwd, WORKFLOWS_DIR));
    return entries.some((name) => /\.(ts|tsx|js|jsx|mjs)$/.test(name));
  } catch {
    // ENOENT and ENOTDIR both mean the same thing to a caller.
    return false;
  }
}
