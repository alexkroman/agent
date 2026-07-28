// Copyright 2025 the AAI authors. MIT license.
/**
 * In-memory bundling of a studio workspace into a deployable worker ESM.
 *
 * Mirrors the CLI bundler (`aai-cli/_bundler.ts`) but sources files from the
 * workspace record instead of disk, and — critically — never evaluates the
 * agent's code on the host. Instead the bundle is wrapped in an entry that
 * extracts the agent config *inside the bundle* (via the dependency-free
 * `@alexkroman1/aai/manifest` helpers) and exports it as `__aaiConfig`; the
 * guest sandbox returns it from `bundle/load` (see `describeBundle`).
 *
 * Import policy: workspace code may import its own files, `@alexkroman1/aai`
 * (any subpath), and `zod`. `node:` builtins stay external (same as the CLI
 * build) — they resolve inside the Deno guest but are permission-gated there.
 */

import path from "node:path";
import {
  build,
  type OnResolveArgs,
  type OnResolveResult,
  type Plugin,
  type PluginBuild,
} from "esbuild";
import { MAX_WORKER_SIZE } from "../constants.ts";

const ENTRY_NS = "aai-studio-entry";
const WORKSPACE_NS = "aai-studio-ws";
/** Virtual specifier the wrapper uses to import the workspace's agent.ts. */
const AGENT_SPECIFIER = "@aai-studio/agent";

/** Bare import prefixes workspace code may use. */
const ALLOWED_PACKAGES = ["@alexkroman1/aai", "zod"];

/** Directory whose node_modules resolves the allowlisted packages. */
const RESOLVE_DIR = path.resolve(import.meta.dirname, "..");

const WRAPPER_ENTRY = `import def from ${JSON.stringify(AGENT_SPECIFIER)};
import { agentToolsToSchemas, toAgentConfig } from "@alexkroman1/aai/manifest";
export default def;
export const __aaiConfig = {
  ...toAgentConfig(def),
  toolSchemas: agentToolsToSchemas(def.tools ?? {}),
};
`;

/** Build failure with esbuild diagnostics formatted for the chat/UI. */
export class StudioBuildError extends Error {}

function isAllowedPackage(spec: string): boolean {
  return ALLOWED_PACKAGES.some((pkg) => spec === pkg || spec.startsWith(`${pkg}/`));
}

function loaderFor(filePath: string): "ts" | "tsx" | "js" | "json" | "text" {
  if (filePath.endsWith(".tsx")) return "tsx";
  if (filePath.endsWith(".json")) return "json";
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) return "js";
  if (filePath.endsWith(".ts")) return "ts";
  // .md and anything else imports as a raw string (CLI raw-md parity).
  return "text";
}

/** Resolve a workspace-relative import, trying TS/JS extensions. */
function resolveWorkspacePath(
  files: Record<string, string>,
  importer: string,
  spec: string,
): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), spec));
  if (base.startsWith("..")) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`]) {
    if (candidate in files) return candidate;
  }
  return null;
}

function resolveError(text: string): OnResolveResult {
  return { errors: [{ text }] };
}

/** Resolve one import written by workspace code (see module doc for policy). */
function resolveFromWorkspace(
  b: PluginBuild,
  files: Record<string, string>,
  args: OnResolveArgs,
): OnResolveResult | Promise<OnResolveResult> | undefined {
  if (args.path.startsWith("./") || args.path.startsWith("../")) {
    const resolved = resolveWorkspacePath(files, args.importer, args.path);
    if (!resolved) return resolveError(`File not found in workspace: ${args.path}`);
    return { path: resolved, namespace: WORKSPACE_NS };
  }
  if (args.path.startsWith("node:")) return { path: args.path, external: true };
  if (!isAllowedPackage(args.path)) {
    return resolveError(
      `Cannot import "${args.path}": studio agents may only import ` +
        `workspace files, ${ALLOWED_PACKAGES.join(", ")}`,
    );
  }
  // Hand the allowlisted package to esbuild's own resolver, anchored at
  // this server package so its node_modules is in scope. `pluginData`
  // breaks the re-entry into this same hook.
  if (args.pluginData?.aaiStudioResolved) return;
  return b.resolve(args.path, {
    resolveDir: RESOLVE_DIR,
    kind: args.kind === "entry-point" ? "import-statement" : args.kind,
    pluginData: { aaiStudioResolved: true },
  });
}

function studioPlugin(files: Record<string, string>): Plugin {
  return {
    name: "aai-studio",
    setup(b) {
      // The wrapper's virtual import of the workspace agent entry.
      b.onResolve({ filter: /^@aai-studio\/agent$/ }, () => ({
        path: "agent.ts",
        namespace: WORKSPACE_NS,
      }));

      // Imports written by workspace code.
      b.onResolve({ filter: /.*/, namespace: WORKSPACE_NS }, (args) =>
        resolveFromWorkspace(b, files, args),
      );

      b.onLoad({ filter: /.*/, namespace: WORKSPACE_NS }, (args) => {
        const contents = files[args.path];
        if (contents === undefined) {
          return { errors: [{ text: `File not found in workspace: ${args.path}` }] };
        }
        return { contents, loader: loaderFor(args.path) };
      });

      // The synthetic wrapper entry itself.
      b.onResolve({ filter: /^aai-studio:entry$/ }, () => ({
        path: "entry.ts",
        namespace: ENTRY_NS,
      }));
      b.onLoad({ filter: /.*/, namespace: ENTRY_NS }, () => ({
        contents: WRAPPER_ENTRY,
        loader: "ts",
        resolveDir: RESOLVE_DIR,
      }));
    },
  };
}

/**
 * Bundle workspace files into a single worker ESM string.
 *
 * @throws {StudioBuildError} with esbuild diagnostics on compile errors.
 */
export async function bundleWorkspace(files: Record<string, string>): Promise<string> {
  if (!files["agent.ts"]) {
    throw new StudioBuildError("Workspace has no agent.ts — create one first");
  }
  let result: Awaited<ReturnType<typeof build>>;
  try {
    result = await build({
      entryPoints: ["aai-studio:entry"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      target: "node20",
      logLevel: "silent",
      // Prefer workspace TypeScript source over dist so a source checkout
      // works without a prior `pnpm build` (same trick as the repo-wide
      // `@dev/source` export condition).
      conditions: ["@dev/source"],
      plugins: [studioPlugin(files)],
    });
  } catch (err) {
    throw new StudioBuildError(formatEsbuildError(err), { cause: err });
  }
  const code = result.outputFiles?.[0]?.text;
  if (!code) throw new StudioBuildError("Build produced no output");
  if (code.length > MAX_WORKER_SIZE) {
    throw new StudioBuildError(`Bundle too large (${code.length} bytes, max ${MAX_WORKER_SIZE})`);
  }
  return code;
}

function formatEsbuildError(err: unknown): string {
  const errors = (
    err as { errors?: { text: string; location?: { file?: string; line?: number } }[] }
  )?.errors;
  if (!Array.isArray(errors) || errors.length === 0) {
    return err instanceof Error ? err.message : String(err);
  }
  const lines = errors.map((e) => {
    const loc = e.location?.file ? `${e.location.file}:${e.location.line ?? 0}: ` : "";
    return `${loc}${e.text}`;
  });
  return `Build failed:\n${lines.join("\n")}`;
}
