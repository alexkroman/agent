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
 * **Only the speech SDKs the agent can reach ride along.** The worker is one
 * file, so the registry's lazy vendor imports are inlined whether or not a
 * session can open them; `omitVendors` replaces the openers of the STT/TTS
 * kinds the agent's config does not declare with a throwing stub
 * (`_vendor-openers.ts`, which carries the measurement and the argument).
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
import { invariant, isRegistryModuleFile } from "@alexkroman1/aai/internal";
import { build, mergeConfig, type PluginOption, type Rollup } from "vite";
import { devSourceViteConfig } from "./_dev-source.ts";
import { errorCode } from "./_utils.ts";
import { omitVendorOpeners } from "./_vendor-openers.ts";
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
  /**
   * Vendor STT/TTS kinds whose runtime opener (and so whose SDK) the bundle
   * leaves out, replaced by a stub that throws when a session opens that
   * stage. `buildAgentBundle` fills this from the agent's own built config —
   * the kinds it does NOT declare — so a deploy carries only the speech SDKs
   * it can reach (`_vendor-openers.ts`). Undefined keeps every vendor in.
   */
  omitVendors?: readonly string[];
};

/**
 * Generated wrapper entry, written under `.aai/` for the duration of the
 * build (the CLI's own scratch dir — dot-paths are ignored by the dev
 * watcher, and the studio's workspace materialization never writes there).
 */
const WRAPPER_ENTRY_REL = path.join(".aai", "worker-entry.ts");

/**
 * A project directory beside `agent.ts` whose files BE the thing — `tools/`
 * or `workflows/` — as file names relative to it.
 *
 * **This is the whole of "discovery", and it happens HERE because the guest has
 * no filesystem.** A sandbox is handed one ESM string, so the only place a
 * directory can be turned into modules is where the bundle is assembled — the
 * same lowering eve does (`readdir` → static import list, which the bundler then
 * follows). The names are validated by the registry (`toolRegistry`,
 * `workflowRegistry` in `@alexkroman1/aai/manifest`) at bundle-evaluation
 * time rather than here, so one implementation owns the rules — and what
 * counts as a module FILE is the SDK's `isRegistryModuleFile`, the rule
 * `virtual:aai/agent` applies too, so a spec sees exactly the set a build
 * ships (a `tools/echo.mts` once shipped here and was invisible there).
 *
 * Both directories are read RECURSIVELY, so a nested file is DISCOVERED and
 * then judged by the registry naming it. A one-level read silently skipped a
 * subdirectory, which made "`tools/` is flat" a documented rule that nothing
 * enforced — `tools/billing/refund.ts` produced an agent with no tools and no
 * error anywhere, the exact silent absence discovery exists to kill; and a
 * `workflows/sub/x.ts` default-exporting a def was skipped the same way while
 * the registry's "nested" refusal never ran. A nested helper module
 * (`workflows/lib/x.ts`) is common and nobody's workflow: it is imported, is
 * no def, and the registry skips it as it skips a flat helper.
 *
 * Sorted, so the emitted entry is byte-stable for a given directory: an entry
 * that reordered per readdir would change the bundle hash for no reason.
 *
 * @internal — exported for its reader-level spec; `buildWorker` is the caller.
 */
export async function discoverModuleFiles(
  cwd: string,
  dir: "tools" | "workflows",
): Promise<string[]> {
  const root = path.join(cwd, dir);
  // `Dirent[]` explicitly: inferring from `fs.readdir` picks its Buffer
  // overload, which the declaration emit rejects even though `tsc --noEmit`
  // on the looser config does not.
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true, recursive: true });
  } catch (err) {
    // A missing directory is normal — a workflow app has no `tools/`, a voice
    // agent no `workflows/`. A FILE of that name is an author's mistake worth a
    // sentence (the raw ENOTDIR named a scandir). Anything else is worth
    // surfacing as it is.
    if (errorCode(err) === "ENOENT") return [];
    if (errorCode(err) === "ENOTDIR") {
      throw new Error(
        `${root} is a file, but \`${dir}/\` must be a DIRECTORY: one file per ${dir === "tools" ? "tool" : "workflow"}, named for it (${dir}/<name>.ts). Move the file into it, or rename it.`,
        { cause: err },
      );
    }
    throw err;
  }
  return (
    entries
      // POSIX separators: these become import specifiers and a registry key, and
      // a backslash on Windows would be neither.
      .map((e) => ({
        file: path.relative(root, path.join(e.parentPath, e.name)).split(path.sep).join("/"),
        isFile: e.isFile(),
      }))
      .filter((e) => e.isFile && isRegistryModuleFile(e.file))
      .map((e) => e.file)
      .sort()
  );
}

/** The prose slot: one file, beside `agent.ts`, named by convention. */
const SYSTEM_PROMPT_FILE = "system-prompt.md";

/**
 * Whether the project keeps its system prompt in a file.
 *
 * The other half of "a file beside `agent.ts` can BE the thing", and it happens
 * here for the same reason `discoverModuleFiles` does — the guest has no
 * filesystem, so the read belongs where the bundle is assembled. What the file
 * MEANS is `withSystemPrompt`'s to decide (a raw config may carry a prompt
 * string of its own, which the file must not silently lose); this only answers
 * whether there is one.
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
      `${nested} is a directory. A system prompt is ONE file — rename it to ${SYSTEM_PROMPT_FILE}, and put text computed beside it in \`promptContext\`. There is deliberately no concatenation order for a directory.`,
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
  workflowFiles: readonly string[],
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
  // The same shape for `workflows/`; `workflowRegistry` keeps the files that
  // default-export a def and skips a body's helpers.
  const workflowImports = workflowFiles
    .map((file, i) => `import * as __aaiWorkflow${i} from "../workflows/${file}";`)
    .join("\n");
  const workflowEntries = workflowFiles
    .map((file, i) => `  ${JSON.stringify(`workflows/${file}`)}: __aaiWorkflow${i},`)
    .join("\n");

  return `import def from "../agent.ts";
import { agentToolsets, agentToolsToSchemas, toAgentConfig, toolRegistry, withSystemPrompt, withTools, withWorkflows, workflowRegistry } from "@alexkroman1/aai/manifest";
${
  runtime
    ? `import { createRuntime } from "@alexkroman1/aai-runtime";
import { GUEST_HOST } from "@alexkroman1/aai-runtime/internal";`
    : ""
}
${systemPromptFile ? `import __aaiSystemPrompt from "../${SYSTEM_PROMPT_FILE}?raw";` : ""}
${toolImports}
${workflowImports}
// A tool's name is its file name. The map is built here rather than written in
// agent.ts, so a file that exists is a tool the model can call — there is no
// registration step to forget. A \`workflows/<name>.ts\` default-exporting a
// \`workflow()\` def is registered as \`<name>\` the same way, an explicit
// \`agent({ workflows })\` entry winning a clash.
//
// \`system-prompt.md\` arrives the same way, and the \`?raw\` lives HERE rather
// than in the author's own \`agent.ts\`: it is a Vite convention, and the whole
// point of generating this entry is that a bundler feature never has to appear
// in user-authored space.
const __aaiAgent = ${systemPromptFile ? "withSystemPrompt(" : ""}withWorkflows(
  withTools(
    def,
    toolRegistry({
${toolEntries}
    }),
  ),
  workflowRegistry({
${workflowEntries}
  }),
)${systemPromptFile ? ", __aaiSystemPrompt)" : ""};
export default __aaiAgent;
export const __aaiConfig = {
  ...toAgentConfig(__aaiAgent),
  toolSchemas: agentToolsToSchemas(agentToolsets(__aaiAgent)),
};
${
  runtime
    ? `// The factory, and (\`host\`) the rest of THIS copy of the runtime the guest
// harness drives the agent through — it carries no runtime of its own.
export const __aaiCreateRuntime = Object.assign(
  (options: Record<string, unknown>) => createRuntime({ ...options, agent: __aaiAgent }),
  { host: GUEST_HOST },
);
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
export async function buildWorker(cwd: string, options: BuildWorkerOptions = {}): Promise<string> {
  const wrapperPath = path.join(cwd, WRAPPER_ENTRY_REL);

  // The two probes are independent reads of the project directory, and this
  // function runs after every settled write burst in the studio — so they
  // overlap with each other and with creating the scratch dir.
  const [, toolFiles, workflowFiles, systemPromptFile] = await Promise.all([
    fs.mkdir(path.dirname(wrapperPath), { recursive: true }),
    discoverModuleFiles(cwd, "tools"),
    discoverModuleFiles(cwd, "workflows"),
    hasSystemPromptFile(cwd),
  ]);
  await fs.writeFile(
    wrapperPath,
    wrapperEntrySource(options.runtime !== false, toolFiles, workflowFiles, systemPromptFile),
    "utf-8",
  );

  // Whatever the caller supplied and nothing else — this used to merge in the
  // DevKit's client transform, which is gone. The key stays ABSENT when the
  // caller supplied none, so a project's own `vite.config.ts` plugins are
  // untouched rather than overwritten with an empty list.
  const plugins = [
    ...(options.plugins ?? []),
    ...(options.omitVendors?.length ? [omitVendorOpeners(cwd, options.omitVendors)] : []),
  ];

  let result: Awaited<ReturnType<typeof build>>;
  try {
    result = await withPreservedNodeEnv(() =>
      build(
        // `AAI_DEV_SOURCE=1`: a linked SDK bundles from its `src/` (`_dev-source.ts`).
        mergeConfig(devSourceViteConfig(), {
          root: cwd,
          logLevel: "silent",
          ...(options.configFile === false && { configFile: false }),
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
            minify: options.minify ? "oxc" : false,
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
      ),
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
