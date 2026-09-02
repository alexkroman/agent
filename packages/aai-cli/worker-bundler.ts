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
import { invariant } from "@alexkroman1/aai/internal";
import { build, type PluginOption, type Rollup } from "vite";
import { errorCode } from "./_utils.ts";
import { withPreservedNodeEnv } from "./_vite-env.ts";

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
  const root = path.join(cwd, "tools");
  // `Dirent[]` explicitly: inferring from `fs.readdir` picks its Buffer
  // overload, which the declaration emit rejects even though `tsc --noEmit`
  // on the looser config does not.
  let entries: Dirent[];
  try {
    // RECURSIVE, so a nested file is DISCOVERED and then rejected by
    // `toolRegistry` naming it. A one-level read silently skipped a
    // subdirectory, which made "`tools/` is flat" a documented rule that
    // nothing enforced: `tools/billing/refund.ts` produced an agent with no
    // tools and no error anywhere — the exact silent absence discovery exists
    // to kill, and verified to happen before this line said `recursive`.
    // Discovering it here rather than throwing here keeps ONE implementation of
    // the rule, in the registry, where the other three already live.
    entries = await fs.readdir(root, { withFileTypes: true, recursive: true });
  } catch (err) {
    // No tools/ directory is normal — a workflow app has none, and a voice
    // agent may declare everything inline. Anything else is worth surfacing.
    if (errorCode(err) === "ENOENT") return [];
    throw err;
  }
  return (
    entries
      .filter((e) => e.isFile() && TOOL_MODULE_EXT_RE.test(e.name) && !TOOL_SPEC_RE.test(e.name))
      // POSIX separators: these become import specifiers and a registry key, and
      // a backslash on Windows would be neither.
      .map((e) => path.relative(root, path.join(e.parentPath, e.name)).split(path.sep).join("/"))
      .sort()
  );
}

/** The prose slot: one file, beside `agent.ts`, named by convention. */
const SYSTEM_PROMPT_FILE = "system-prompt.md";

/**
 * Whether the project keeps its system prompt in a file.
 *
 * The other half of "a file beside `agent.ts` can BE the thing", and it happens
 * here for the same reason `discoverToolFiles` does — the guest has no
 * filesystem, so the read belongs where the bundle is assembled. What the file
 * MEANS is `withSystemPrompt`'s to decide (the author may have imported and
 * composed it, in which case discovery must not apply it twice); this only
 * answers whether there is one.
 */
async function hasSystemPromptFile(cwd: string): Promise<boolean> {
  // A `system-prompt/` DIRECTORY is rejected rather than ignored. eve supports
  // one and no project here needs one, so picking a concatenation order now
  // would freeze a guess — but SILENCE is the wrong way to decline it: an author
  // who writes `system-prompt/intro.md` gets the framework default with nothing
  // saying why, which is the same silent absence this whole mechanism exists to
  // kill. Verified: before this check the directory case fell through to
  // DEFAULT_SYSTEM_PROMPT.
  const nested = path.join(cwd, "system-prompt");
  const nestedStat = await fs.stat(nested).catch(() => undefined);
  if (nestedStat?.isDirectory() === true) {
    throw new Error(
      `${nested} is a directory. A system prompt is ONE file — rename it to ${SYSTEM_PROMPT_FILE}, or import the pieces yourself and compose them into \`systemPrompt\`. There is deliberately no concatenation order for a directory.`,
    );
  }
  try {
    return (await fs.stat(path.join(cwd, SYSTEM_PROMPT_FILE))).isFile();
  } catch (err) {
    if (errorCode(err) === "ENOENT") return false;
    throw err;
  }
}

function wrapperEntrySource(
  runtime: boolean,
  toolFiles: readonly string[],
  systemPromptFile: boolean,
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
import { agentToolsToSchemas, toAgentConfig, toolRegistry, withSystemPrompt, withTools } from "@alexkroman1/aai/manifest";
${runtime ? `import { createRuntime } from "@alexkroman1/aai-runtime";` : ""}
${systemPromptFile ? `import __aaiSystemPrompt from "../${SYSTEM_PROMPT_FILE}?raw";` : ""}
${toolImports}
// A tool's name is its file name. The map is built here rather than written in
// agent.ts, so a file that exists is a tool the model can call — there is no
// registration step to forget.
//
// \`system-prompt.md\` arrives the same way, and the \`?raw\` lives HERE rather
// than in the author's own \`agent.ts\`: it is a Vite convention, and the whole
// point of generating this entry is that a bundler feature never has to appear
// in user-authored space.
const __aaiAgent = ${systemPromptFile ? "withSystemPrompt(" : ""}withTools(
  def,
  toolRegistry({
${toolEntries}
  }),
)${systemPromptFile ? ", __aaiSystemPrompt)" : ""};
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

  // The two probes are independent reads of the project directory, and this
  // function runs after every settled write burst in the studio — so they
  // overlap with each other and with creating the scratch dir.
  const [, toolFiles, systemPromptFile] = await Promise.all([
    fs.mkdir(path.dirname(wrapperPath), { recursive: true }),
    discoverToolFiles(cwd),
    hasSystemPromptFile(cwd),
  ]);
  await fs.writeFile(
    wrapperPath,
    wrapperEntrySource(opts.runtime !== false, toolFiles, systemPromptFile),
    "utf-8",
  );

  // Whatever the caller supplied and nothing else — this used to merge in the
  // DevKit's client transform, which is gone. The key stays ABSENT when the
  // caller supplied none, so a project's own `vite.config.ts` plugins are
  // untouched rather than overwritten with an empty list.
  const plugins = opts.plugins ?? [];

  let result: Awaited<ReturnType<typeof build>>;
  try {
    result = await withPreservedNodeEnv(() =>
      build({
        root: cwd,
        logLevel: "silent",
        ...(opts.configFile === false && { configFile: false }),
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
  // Both are properties of the config a few lines up rather than of anything a
  // caller passed: one `input`, `codeSplitting: false`, and a `build()` (not a
  // watch), so exactly one output carrying exactly one entry chunk. A miss is
  // this module having mis-built its own config.
  invariant(output !== undefined, "bundle.worker.output");
  const chunk = output.output.find((o): o is Rollup.OutputChunk => o.type === "chunk" && o.isEntry);
  invariant(chunk !== undefined, "bundle.worker.entry-chunk", () => ({
    kinds: output.output.map((o) => o.type),
  }));
  return chunk.code;
}
