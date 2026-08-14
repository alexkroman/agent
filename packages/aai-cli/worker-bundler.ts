// Copyright 2025 the AAI authors. MIT license.

/**
 * Worker bundling — the one implementation of "turn an `agent.ts` into the
 * ESM the guest sandbox loads".
 *
 * Public (no `_` prefix) for the same reason as `client-bundler.ts`: the
 * platform's browser studio builds its workspaces through this function, so a
 * worker published from the browser comes out of the same Vite/Rollup pass as
 * one from `aai deploy`.
 *
 * @internal — build hook for aai-server/the studio; not a supported public
 * API and not covered by semver. The lack of a `_` prefix is packaging (the
 * subpath must be importable cross-package), not an invitation: user code
 * should never import from `@alexkroman1/aai-cli`.
 *
 * Every worker is built through a generated wrapper entry that re-exports the
 * agent *and* its extracted config as `__aaiConfig` (via the dependency-free
 * `@alexkroman1/aai/manifest` helpers, bundled in). The guest harness returns
 * that export from `bundle/load`, which is how the platform obtains an
 * agent's config without ever evaluating tenant code on the host — the
 * `POST /deploy` route and the studio's sandbox inspection both rely on it.
 *
 * **The worker ships its own runtime.** Deploy builds also export
 * `__aaiCreateRuntime` — a factory over the *user's installed* SDK's
 * `createRuntime`, bundled in alongside the provider SDKs. The guest harness
 * builds the session runtime through it, so a deployed agent runs exactly the
 * runtime version it was built and tested against (identical to `aai dev`),
 * instead of whatever SDK the platform's harness image was baked with. The
 * harness↔bundle contract is deliberately tiny: the factory takes
 * `{ env, db?, runCode? }` and returns `{ startSession, shutdown }`.
 *
 * What the studio supplies via options, because a workspace is not a project:
 *
 * - **`configFile: false`.** Workspace files are untrusted and a Vite config
 *   is executable host code.
 * - **`plugins`.** The studio adds its import allowlist; without it, Vite
 *   would happily resolve any package in the server's `node_modules`.
 */

import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { build, type PluginOption, type Rollup } from "vite";
import { withPreservedNodeEnv } from "./_vite-env.ts";
import { type WorkflowBundleOutput, workflowClientPlugin } from "./workflow-bundler.ts";

/**
 * Options for worker bundling.
 *
 * @internal — build hook for aai-server/the studio; not a supported public
 * API and not covered by semver.
 */
export type BuildWorkerOptions = {
  /**
   * Minify the worker with Oxc (Vite 8's native minifier). Deploy builds set
   * this to shrink the upload payload; dev builds stay unminified for
   * readable stack traces.
   */
  minify?: boolean;
  /** `false` ignores any `vite.config.ts` under `cwd` (see module doc). */
  configFile?: false;
  /** Extra plugins (the studio's import allowlist). */
  plugins?: PluginOption[];
  /**
   * Bundle the SDK runtime into the worker (`__aaiCreateRuntime` — see the
   * module doc). Default true; deploy artifacts must ship it. The dev server
   * passes `false`: it builds its runtime in-process from the same installed
   * SDK anyway, and inlining the runtime + provider SDKs on every file-watch
   * rebuild would turn the watch loop from sub-second into multi-second.
   */
  runtime?: boolean;
  /**
   * The project's compiled workflows, when it declares any.
   *
   * Embedded in the worker as two string exports rather than shipped as extra
   * files, because the guest's `bundle/load` contract is ONE ESM string. See
   * `wrapperEntrySource`.
   *
   * It also switches on the client transform (`workflowClientPlugin`), which is
   * what puts a `workflowId` on the agent's own copy of each body. Passing the
   * strings without it produces a bundle that serves every workflow route and
   * cannot start a run.
   */
  workflows?: WorkflowBundleOutput | undefined;
};

/**
 * Generated wrapper entry, written under `.aai/` for the duration of the
 * build (the CLI's own scratch dir — dot-paths are ignored by the dev
 * watcher, and the studio's workspace materialization never writes there).
 */
const WRAPPER_ENTRY_REL = path.join(".aai", "worker-entry.ts");

/** Extensions a tool module may be authored in (mirrors the SDK's registry). */
const TOOL_MODULE_EXT_RE = /\.(?:m?ts|tsx)$/;

/** A co-located spec is not a tool. */
const TOOL_SPEC_RE = /\.(?:test|spec)\.[^.]+$/;

/**
 * The project's `tools/` directory, as file names relative to it.
 *
 * **This is the whole of "discovery", and it happens HERE because the guest has
 * no filesystem.** A sandbox is handed one ESM string, so the only place a
 * directory can be turned into modules is where the bundle is assembled — the
 * same lowering eve does (`readdir` → static import list, which the bundler then
 * follows). The names are validated by `toolRegistry` at bundle-evaluation time
 * rather than here, so one implementation owns the rules.
 *
 * Sorted, so the emitted entry is byte-stable for a given directory: an entry
 * that reordered per readdir would change the bundle hash for no reason.
 */
async function discoverToolFiles(cwd: string): Promise<string[]> {
  // `Dirent[]` explicitly: inferring from `fs.readdir` picks its Buffer
  // overload, which the declaration emit rejects even though `tsc --noEmit`
  // on the looser config does not.
  let entries: Dirent[];
  try {
    entries = await fs.readdir(path.join(cwd, "tools"), { withFileTypes: true });
  } catch (err) {
    // No tools/ directory is normal — a workflow app has none, and a voice
    // agent may declare everything inline. Anything else is worth surfacing.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((e) => e.isFile() && TOOL_MODULE_EXT_RE.test(e.name) && !TOOL_SPEC_RE.test(e.name))
    .map((e) => e.name)
    .sort();
}

function wrapperEntrySource(
  runtime: boolean,
  workflows: WorkflowBundleOutput | undefined,
  toolFiles: readonly string[],
): string {
  // `import * as` rather than a default import per file: the namespace is what
  // `toolRegistry` validates, so a file exporting the wrong thing (or nothing)
  // is a named build error instead of an `undefined` in the map.
  const toolImports = toolFiles
    .map((file, i) => `import * as __aaiTool${i} from "../tools/${file}";`)
    .join("\n");
  const toolEntries = toolFiles
    .map((file, i) => `  ${JSON.stringify(`tools/${file}`)}: __aaiTool${i},`)
    .join("\n");

  return `import def from "../agent.ts";
import { agentToolsToSchemas, toAgentConfig, toolRegistry, withTools } from "@alexkroman1/aai/manifest";
${runtime ? `import { createRuntime } from "@alexkroman1/aai/runtime";` : ""}
${toolImports}
// A tool's name is its file name. The map is built here rather than written in
// agent.ts, so a file that exists is a tool the model can call — there is no
// registration step to forget.
const __aaiAgent = withTools(
  def,
  toolRegistry({
${toolEntries}
  }),
);
export default __aaiAgent;
export const __aaiConfig = {
  ...toAgentConfig(__aaiAgent),
  toolSchemas: agentToolsToSchemas(__aaiAgent.tools ?? {}),
};
${
  runtime
    ? `export const __aaiCreateRuntime = (opts: Record<string, unknown>) =>
  createRuntime({ ...opts, agent: __aaiAgent });
`
    : ""
}${
  workflows
    ? `// The compiled workflow surface, carried as DATA. \`__aaiWorkflowCode\` goes to
// \`workflowEntrypoint(code)\` and \`__aaiStepCode\` is evaluated by the guest so its
// \`registerStepFunction\` calls run. Strings rather than modules because the guest
// receives exactly one ESM string and never sees this project's filesystem.
export const __aaiWorkflowCode = ${JSON.stringify(workflows.workflowCode)};
export const __aaiStepCode = ${JSON.stringify(workflows.stepCode)};
`
    : ""
}`;
}

/**
 * Bundle agent.ts into a single ESM string for the sandbox worker.
 *
 * Zod is bundled in — zod 4's `Function()` usage is wrapped in try/catch
 * and gracefully degrades in restricted environments like Deno.
 *
 * @internal — build hook for aai-server/the studio; not a supported public
 * API and not covered by semver.
 */
export async function buildWorker(cwd: string, opts: BuildWorkerOptions = {}): Promise<string> {
  const wrapperPath = path.join(cwd, WRAPPER_ENTRY_REL);

  await fs.mkdir(path.dirname(wrapperPath), { recursive: true });
  await fs.writeFile(
    wrapperPath,
    wrapperEntrySource(opts.runtime !== false, opts.workflows, await discoverToolFiles(cwd)),
    "utf-8",
  );

  const plugins: PluginOption[] = [
    ...(opts.plugins ?? []),
    ...(opts.workflows ? [workflowClientPlugin(cwd, opts.workflows.inputFiles)] : []),
  ];

  let result: Awaited<ReturnType<typeof build>>;
  try {
    result = await withPreservedNodeEnv(() =>
      build({
        root: cwd,
        logLevel: "silent",
        ...(opts.configFile === false && { configFile: false }),
        // The client transform runs alongside whatever the caller supplied (the
        // studio's import allowlist), not instead of it. The key stays absent
        // when there is nothing to add, so a project's own `vite.config.ts`
        // plugins are unaffected either way.
        ...(plugins.length > 0 && { plugins }),
        // Bundle everything (the guest sandbox has no node_modules) EXCEPT
        // `node:` builtins, which the SSR build keeps external. Without the
        // SSR switch Vite treats this as a browser build and replaces the
        // runtime's `node:` imports with "externalized for browser
        // compatibility" throw-stubs.
        ssr: { noExternal: true },
        build: {
          // The worker runs in the Node guest, not a browser: server resolve
          // conditions, no browser main field, `node:` builtins external.
          ssr: true,
          lib: { entry: wrapperPath, formats: ["es"], fileName: "worker" },
          target: "node20",
          minify: opts.minify ? "oxc" : false,
          write: false,
          rollupOptions: {
            output: {
              entryFileNames: "[name].js",
              // The providers' lazy imports must be inlined rather than
              // emitted as sibling chunks — the worker is delivered as ONE
              // ESM string over bundle/load (same rule as the guest
              // harness's tsdown config). Rolldown's spelling of
              // `inlineDynamicImports: true` (which it deprecated).
              codeSplitting: false,
            },
          },
        },
      }),
    );
  } finally {
    await fs.rm(wrapperPath, { force: true }).catch(() => undefined);
  }

  const output = Array.isArray(result) ? result[0] : (result as Rollup.RollupOutput);
  if (!output) throw new Error("Vite produced no output for agent.ts");
  const chunk = output.output.find((o): o is Rollup.OutputChunk => o.type === "chunk" && o.isEntry);
  if (!chunk) throw new Error("Vite produced no entry chunk for agent.ts");
  return chunk.code;
}
