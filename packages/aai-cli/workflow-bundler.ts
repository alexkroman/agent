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
 *   itself at the other end. Flow bundle: 3.7 MB → ~69 KB.
 *
 * So `workflowCode` is passed to `workflowEntrypoint()` in the guest and
 * `stepCode` is evaluated there to register its step functions.
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
import path from "node:path";
import { BaseBuilder } from "@workflow/builders";

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
   * off each body's own `workflowId` property; this is kept because it is also
   * the only machine-readable list of what the project declares, which the
   * studio's workflows card renders.
   */
  manifest: unknown;
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
  private readonly outDir: string;

  constructor(cwd: string, outDir: string) {
    super({
      buildTarget: "standalone",
      dirs: [`./${WORKFLOWS_DIR}`],
      workingDir: cwd,
      projectRoot: cwd,
      moduleSpecifierRoot: cwd,
      externalPackages: [...WDK_EXTERNAL],
      stepsBundlePath: path.join(outDir, "step.mjs"),
      workflowsBundlePath: path.join(outDir, "flow.mjs"),
      webhookBundlePath: path.join(outDir, "webhook.mjs"),
      // The builder narrates each bundle at info level, which is noise inside
      // `aai build` and actively wrong inside `aai dev`'s watch loop.
      suppressCreateWorkflowsBundleLogs: true,
      suppressCreateWebhookBundleLogs: true,
      suppressCreateManifestLogs: true,
    });
    this.outDir = outDir;
  }

  override async build(): Promise<void> {
    const inputFiles = await this.getInputFiles();
    const flowFile = path.join(this.outDir, "flow.mjs");
    const stepFile = path.join(this.outDir, "step.mjs");

    const { manifest } = await this.createWorkflowsBundle({
      inputFiles,
      format: "esm",
      outfile: flowFile,
      // See the module doc — this is the 3.7 MB → 69 KB setting.
      bundleFinalOutput: false,
    });
    await this.createStepsBundle({ inputFiles, format: "esm", outfile: stepFile });

    const [workflowCode, stepCode] = await Promise.all([
      fs.readFile(flowFile, "utf-8"),
      fs.readFile(stepFile, "utf-8"),
    ]);
    this.output = { workflowCode, stepCode, manifest };
  }
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
