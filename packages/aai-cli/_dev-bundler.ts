// Copyright 2025 the AAI authors. MIT license.

/**
 * Fast worker builds for `aai dev`.
 *
 * The deploy path (`buildWorker` in `worker-bundler.ts`) is a full Vite
 * pipeline pass — right for a one-shot `aai deploy`, but 1–3 s per save when
 * the dev watcher runs it on every change. This module builds with Rolldown
 * directly (the native bundler Vite 8 itself runs on, so it adds no install
 * weight), skipping Vite's config/plugin/CSS machinery: a from-scratch build
 * of a typical agent lands in tens of ms. Deploy keeps Vite untouched, so
 * nothing that ships is produced by this path.
 *
 * Parity with `buildWorker` where it matters for dev:
 *
 * - single-file ESM output, unminified (dev builds never minify);
 * - `node:` builtins external (Rolldown's `platform: "node"`), everything
 *   else — zod, workspace deps, local imports — bundled in;
 * - `.md` imports resolve to their raw text (`mdPlugin` below is
 *   `rawMdPlugin`'s transform), and Vite-style `?raw` suffix imports are
 *   honored via `rawSuffixPlugin`.
 *
 * Known dev/deploy differences, accepted: Vite's lib build applies
 * `define`/`import.meta.env` replacements this path does not. When a build
 * fails for anything other than a compile error in the agent's code, the
 * caller falls back to the cold Vite path (see `_dev-server.ts`), so a
 * resolution gap here degrades to the old slow-but-correct behavior rather
 * than a broken dev server.
 *
 * Rolldown does not touch `process.env` the way Vite's `build()` does, so
 * the `withPreservedNodeEnv` wrapper Vite builds need is not required here.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "rolldown";
import {
  CONVENTIONS_ENTRY_ID,
  discoverConventions,
  generateConventionsEntry,
  redirectsToAgentEntry,
} from "./_conventions.ts";

const RAW_NAMESPACE = "\0aai-raw:";

/**
 * Vite serves `import x from "./file?raw"` as the file's text. Rolldown
 * treats the suffix as part of the filename, so resolve it explicitly and
 * load the real file as a string export.
 */
const rawSuffixPlugin: Plugin = {
  name: "aai-raw-suffix",
  resolveId: {
    filter: { id: /\?raw$/ },
    handler(id, importer) {
      const file = id.slice(0, -"?raw".length);
      const base = importer ? path.dirname(importer) : process.cwd();
      return RAW_NAMESPACE + path.resolve(base, file);
    },
  },
  load: {
    filter: { id: new RegExp(`^${RAW_NAMESPACE}`) },
    async handler(id) {
      const text = await fs.readFile(id.slice(RAW_NAMESPACE.length), "utf8");
      return `export default ${JSON.stringify(text)};`;
    },
  },
};

/** `.md` imports resolve to their raw text (rawMdPlugin parity). */
const mdPlugin: Plugin = {
  name: "aai-raw-md",
  load: {
    filter: { id: /\.md$/ },
    async handler(id) {
      const text = await fs.readFile(id, "utf8");
      return `export default ${JSON.stringify(text)};`;
    },
  },
};

/**
 * Rolldown side of `worker-bundler.ts`'s `conventionsPlugin`: redirect
 * `agent.ts` to the generated entry composing the directory's convention
 * files (`instructions.md`, `tools/`, `skills/` — see `_conventions.ts`).
 */
function devConventionsPlugin(agentPath: string, entryCode: string): Plugin {
  return {
    name: "aai-conventions",
    resolveId(source, importer) {
      return redirectsToAgentEntry(source, importer, agentPath) ? CONVENTIONS_ENTRY_ID : null;
    },
    load(id) {
      return id === CONVENTIONS_ENTRY_ID ? entryCode : null;
    },
  };
}

/**
 * True for bundler build failures — compile/resolve errors in the code being
 * built (Rolldown aggregates its diagnostics onto an `errors` array, the same
 * shape esbuild used). Anything else coming out of `build()` is a
 * bundler-infrastructure problem, which callers treat as "fall back to the
 * cold Vite path" rather than "the user's code is broken".
 */
export function isBundlerBuildFailure(err: unknown): boolean {
  return (
    err instanceof Error && "errors" in err && Array.isArray((err as { errors: unknown }).errors)
  );
}

/** Dev builder for one agent directory. */
export type DevWorkerBuilder = {
  /** Build the worker ESM for `agent.ts`. */
  build(): Promise<string>;
  /** Release resources. Safe to call more than once. */
  dispose(): Promise<void>;
};

/**
 * Create a dev builder for the agent at `cwd`.
 *
 * Each `build()` is a from-scratch Rolldown pass — native-code bundling is
 * fast enough (tens of ms for a typical agent) that no incremental context
 * is worth holding between saves. `dispose()` exists for interface parity
 * with resource-holding builders and is a no-op.
 */
export function createDevWorkerBuilder(cwd: string): DevWorkerBuilder {
  return {
    async build(): Promise<string> {
      const { rolldown } = await import("rolldown");
      const agentPath = path.join(cwd, "agent.ts");
      // Re-discovered on every build: convention files can appear or vanish
      // between saves, and the watcher restart that triggered this build is
      // exactly when that has to be picked up (buildWorker parity).
      const conventions = await discoverConventions(cwd);
      const conventionPlugins = conventions
        ? [devConventionsPlugin(agentPath, generateConventionsEntry(agentPath, conventions))]
        : [];
      const bundle = await rolldown({
        input: agentPath,
        cwd,
        platform: "node",
        logLevel: "silent",
        plugins: [...conventionPlugins, rawSuffixPlugin, mdPlugin],
      });
      try {
        const result = await bundle.generate({ format: "esm", minify: false });
        const file = result.output[0];
        if (!file) throw new Error("Rolldown produced no output for agent.ts");
        return file.code;
      } finally {
        await bundle.close().catch(() => undefined);
      }
    },

    async dispose(): Promise<void> {
      // Nothing held between builds — see the factory doc comment.
    },
  };
}
