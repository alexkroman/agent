// Copyright 2025 the AAI authors. MIT license.
/**
 * Bundle a studio workspace into the deployable worker ESM.
 *
 * This does **not** reimplement the CLI's worker build — it calls `buildWorker`
 * from `@alexkroman1/aai-cli/worker-bundler`, the same Vite/Rollup pass
 * `aai deploy` runs, so a worker published from the browser matches one built
 * on a laptop. What the studio adds on top is policy:
 *
 * - **The config wrapper.** The entry re-exports the agent *and* its config as
 *   `__aaiConfig` (extracted with the dependency-free
 *   `@alexkroman1/aai/manifest` helpers), so the guest sandbox can report the
 *   config back from `bundle/load`. The host never evaluates agent code — the
 *   CLI's own `buildAgentBundle` does (`evalWorkerBundle`), which is exactly
 *   why only `buildWorker` is reused here and not the whole bundle step.
 * - **The import allowlist** (`allowlistPlugin`). Vite resolves from the
 *   server's own `node_modules`, so without this a workspace could pull any
 *   server dependency into the guest bundle. Workspace code may import its own
 *   files, `@alexkroman1/aai` (any subpath), and `zod`; `node:` builtins stay
 *   external (CLI parity — they resolve inside the Deno guest but are
 *   permission-gated there).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { buildWorker } from "@alexkroman1/aai-cli/worker-bundler";
import type { PluginOption } from "vite";
import { MAX_WORKER_SIZE } from "../constants.ts";
import { StudioBuildError } from "./studio-errors.ts";

export { StudioBuildError } from "./studio-errors.ts";

/** Bare import prefixes workspace code may use. */
const ALLOWED_PACKAGES = ["@alexkroman1/aai", "zod"];

/** Generated entry filename, written into the scratch dir alongside agent.ts. */
export const WRAPPER_ENTRY_FILE = "__aai-entry.ts";

export const WRAPPER_ENTRY = `import def from "./agent.ts";
import { agentToolsToSchemas, toAgentConfig } from "@alexkroman1/aai/manifest";
export default def;
export const __aaiConfig = {
  ...toAgentConfig(def),
  toolSchemas: agentToolsToSchemas(def.tools ?? {}),
};
`;

async function fileExists(p: string): Promise<boolean> {
  return await fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

function isAllowedPackage(spec: string): boolean {
  return ALLOWED_PACKAGES.some((pkg) => spec === pkg || spec.startsWith(`${pkg}/`));
}

/**
 * Enforce the import policy for modules imported *by workspace code*.
 *
 * Only imports whose importer lives inside the scratch dir are policed —
 * `@alexkroman1/aai`'s own dependencies resolve from `node_modules` and must
 * pass through untouched.
 */
export function allowlistPlugin(dir: string): PluginOption {
  const prefix = `${dir}${path.sep}`;
  const inWorkspace = (id: string | undefined): id is string =>
    id !== undefined && id.startsWith(prefix) && !id.includes(`${path.sep}node_modules${path.sep}`);

  /**
   * The scratch dir is a real directory inside the server package, so a `../`
   * climb would reach server source (or anything else on disk) and bundle it
   * into the guest worker. "File not found" is no longer what stops that —
   * this is. Absolute paths never resolve either.
   */
  const assertInsideWorkspace = (source: string, importer: string): void => {
    const target = path.isAbsolute(source) ? source : path.resolve(path.dirname(importer), source);
    if (target !== dir && !target.startsWith(prefix)) {
      throw new StudioBuildError(`Import "${source}" escapes the workspace`);
    }
  };

  return {
    name: "aai-studio-allowlist",
    enforce: "pre",
    resolveId(source: string, importer: string | undefined) {
      if (!inWorkspace(importer)) return null;
      if (source.startsWith(".") || path.isAbsolute(source)) {
        assertInsideWorkspace(source, importer);
        return null; // inside the workspace — let Vite resolve it
      }
      if (source.startsWith("node:")) return { id: source, external: true };
      if (isAllowedPackage(source)) return null;
      throw new StudioBuildError(
        `Cannot import "${source}": studio agents may only import ` +
          `workspace files, ${ALLOWED_PACKAGES.join(", ")}`,
      );
    },
  };
}

/**
 * Bundle a materialized workspace directory into a single worker ESM string.
 *
 * @throws {StudioBuildError} with Vite diagnostics on compile errors.
 */
export async function bundleWorkspaceWorker(dir: string): Promise<string> {
  if (!(await fileExists(path.join(dir, "agent.ts")))) {
    throw new StudioBuildError("Workspace has no agent.ts — create one first");
  }
  // The wrapper is generated, not user content, so it is written here rather
  // than materialized with the workspace.
  await fs.writeFile(path.join(dir, WRAPPER_ENTRY_FILE), WRAPPER_ENTRY, "utf-8");

  let code: string;
  try {
    code = await buildWorker(dir, {
      entry: WRAPPER_ENTRY_FILE,
      // A vite.config.ts in the workspace is executable host code and
      // workspace files are untrusted, so any config written there is inert.
      configFile: false,
      plugins: [allowlistPlugin(dir)],
      minify: true,
    });
  } catch (err) {
    throw new StudioBuildError(formatBuildError(err, dir), { cause: err });
  }
  if (code.length > MAX_WORKER_SIZE) {
    throw new StudioBuildError(`Bundle too large (${code.length} bytes, max ${MAX_WORKER_SIZE})`);
  }
  return code;
}

/**
 * Format a Vite/Rollup build failure for the chat and the UI.
 *
 * Diagnostics are scrubbed of the scratch-dir prefix and terminal colour
 * codes: the coding agent (and the user reading the chat) only knows the
 * workspace, so a path like `.studio-build/<uuid>/agent.ts` is noise it might
 * try to "fix".
 */
function formatBuildError(err: unknown, dir: string): string {
  // Allowlist rejections are already the message we want to show.
  const cause = (err as { cause?: unknown })?.cause;
  if (err instanceof StudioBuildError) return err.message;
  if (cause instanceof StudioBuildError) return cause.message;

  const e = err as { message?: string; id?: string; loc?: { file?: string; line?: number } };
  const file = e?.loc?.file ?? e?.id;
  const where = file ? `${path.basename(file)}${e.loc?.line ? `:${e.loc.line}` : ""}: ` : "";
  return scrub(`Build failed:\n${where}${e?.message ?? String(err)}`, dir);
}

/**
 * ANSI SGR sequences. Built from a char code rather than written as a literal
 * escape so the pattern carries no control character.
 */
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * Strip scratch-dir paths and ANSI colour codes from a diagnostic.
 *
 * Rollup reports paths relative to `process.cwd()` while Vite's own errors
 * carry absolute ones, so both spellings of the scratch dir are removed.
 */
export function scrub(message: string, dir: string): string {
  const forms = [dir, path.relative(process.cwd(), dir)].filter(Boolean);
  let out = message.replace(ANSI_SGR, "");
  for (const form of forms) {
    out = out.split(`${form}${path.sep}`).join("").split(form).join(".");
  }
  return out;
}
