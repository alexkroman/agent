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

import fs from "node:fs/promises";
import path from "node:path";
import { build, type PluginOption, type Rollup } from "vite";
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

function wrapperEntrySource(runtime: boolean): string {
  return `import def from "../agent.ts";
import { agentToolsToSchemas, toAgentConfig } from "@alexkroman1/aai/manifest";
${runtime ? `import { createRuntime } from "@alexkroman1/aai/runtime";` : ""}
export default def;
export const __aaiConfig = {
  ...toAgentConfig(def),
  toolSchemas: agentToolsToSchemas(def.tools ?? {}),
};
${
  runtime
    ? `export const __aaiCreateRuntime = (opts: Record<string, unknown>) =>
  createRuntime({ ...opts, agent: def });
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
  await fs.writeFile(wrapperPath, wrapperEntrySource(opts.runtime !== false), "utf-8");

  let result: Awaited<ReturnType<typeof build>>;
  try {
    result = await withPreservedNodeEnv(() =>
      build({
        root: cwd,
        logLevel: "silent",
        ...(opts.configFile === false && { configFile: false }),
        ...(opts.plugins && { plugins: opts.plugins }),
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
