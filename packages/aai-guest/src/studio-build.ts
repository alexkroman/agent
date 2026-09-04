// Copyright 2026 the AAI authors. MIT license.
/**
 * Guest-side workspace builds — THE build path for studio agents.
 *
 * Builds run here, in the tenant's own sandbox, through the aai CLI's own
 * bundlers (`@alexkroman1/aai-cli/worker-bundler` + `/client-bundler`) — the
 * exact functions `aai deploy` runs on a laptop. There is no host-side build
 * backend: one path, exercised by every `test_agent` call and every Publish,
 * so the studio and CLI builds cannot diverge. A hostile or pathological
 * workspace burns this sandbox's CPU and nothing else — the container is the
 * isolation boundary, exactly as for the tools.
 *
 * The bundler runs IN this process. A one-shot child-process variant (#845,
 * motivated by Rolldown's native memory staying resident in the long-lived
 * harness — ~1.5 GB per build, reclaimed only on process exit) was reverted
 * after it didn't work in practice; see that PR for the measurements if
 * revisiting.
 *
 * The toolchain is NOT bundled into the harness: it resolves at runtime
 * from the `node_modules` that live next to the harness — baked into the
 * guest snapshot image in production (see aai-server's
 * modal-harness-image.ts), this package's own dependencies in dev/tests.
 * Workspaces are materialized under the same root so their bare imports
 * (`@alexkroman1/aai`, `zod`, `@alexkroman1/aai-ui`, `react`) resolve by
 * the normal node_modules walk-up, exactly as in a user project.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { errorMessage } from "@alexkroman1/aai";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { annotateDiagnostics, type ExportResolver } from "./studio-diagnostics.ts";
import {
  ensureWorkspaceDependencies,
  type WorkspaceDependencyOptions,
  withDependencyWarning,
} from "./studio-workspace-deps.ts";

/** Result of one guest build; `buildError` is prose the coding agent can act on. */
export type GuestBuildResult = {
  worker?: string;
  clientFiles?: Record<string, string>;
  buildError?: string;
};

type Toolchain = {
  buildWorker: (cwd: string, opts: { minify?: boolean; configFile?: false }) => Promise<string>;
  buildClient: (
    cwd: string,
    opts: { configFile?: false; plugins?: unknown[] },
  ) => Promise<Record<string, string>>;
  clientPlugins: () => unknown[];
  typecheckProject: (
    cwd: string,
  ) => Promise<{ ok: true; skipped: boolean } | { ok: false; output: string }>;
};

/**
 * Root under which THIS PROCESS's workspaces materialize: a dot-directory next
 * to this module (→ next to the bundled harness.mjs), because that location —
 * and only that location — has the toolchain's `node_modules` above it, then
 * one level per process id.
 *
 * The pid separates two harness processes' scratch trees. It has to be
 * somewhere: under the subprocess backend every sandbox on the machine execs
 * the same `packages/aai-guest/dist/harness.mjs`, so this path is shared by
 * every one of them. It used to live in the child names (`session-<pid>`,
 * `build-<pid>-<n>`); one level up is the same guarantee said once.
 */
export function workspacesRoot(): string {
  return path.join(import.meta.dirname, ".workspaces", String(process.pid));
}

/**
 * The directory whose `node_modules` holds the baked toolchain, found by
 * walking up from this module — or null if the walk finds none.
 *
 * Deliberately a search rather than a fixed offset, because the harness sits
 * at a different depth in the two layouts: `/opt/aai/harness.mjs` beside
 * `/opt/aai/node_modules` in the Modal image, but
 * `packages/aai-guest/dist/harness.mjs` under the subprocess backend, whose
 * node_modules is a level higher again. Bare imports resolve either way by
 * Node's own walk-up, so nothing that merely *imports* has to care. Anything
 * that has to NAME the directory does: the coding agent reading SDK types
 * with bash, and the workspace manifest pinning versions below. A relative
 * depth hardcoded from one layout is correct in production and quietly wrong
 * in local dev — and only the source-tree layout is what unit tests see, so
 * it looks right from all three angles a test could take.
 */
export function toolchainRoot(): string | null {
  let dir = import.meta.dirname;
  for (;;) {
    if (existsSync(path.join(dir, "node_modules", "@alexkroman1", "aai"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The baked toolchain's `node_modules` directory, or null when not found. */
export function toolchainModules(): string | null {
  const root = toolchainRoot();
  return root === null ? null : path.join(root, "node_modules");
}

/**
 * The guest's dependency layout, for every site that prepares a workspace to be
 * built (session install, `test_agent` build, Publish). A function rather than
 * a constant so it stays resolved-on-use, and passed as options rather than
 * imported by `studio-workspace-deps.ts`, because this module imports IT.
 */
export function workspaceDependencyOptions(): WorkspaceDependencyOptions {
  return { toolchainModules: toolchainModules() };
}

// Memoized lazy load: pool-spawned warm harnesses must not pay the Vite
// import at boot, and a missing toolchain should fail the BUILD (a message
// the coding agent sees), not the harness.
let toolchain: Promise<Toolchain> | null = null;
function loadToolchain(): Promise<Toolchain> {
  toolchain ??= (async (): Promise<Toolchain> => {
    const [worker, client, typecheck, react, tailwind] = await Promise.all([
      import("@alexkroman1/aai-cli/worker-bundler"),
      import("@alexkroman1/aai-cli/client-bundler"),
      import("@alexkroman1/aai-cli/typecheck"),
      import("@vitejs/plugin-react"),
      import("@tailwindcss/vite"),
    ]);
    return {
      buildWorker: worker.buildWorker,
      buildClient: client.buildClient as Toolchain["buildClient"],
      // Fresh plugin instances per build — Vite plugins are stateful.
      clientPlugins: () => [react.default(), tailwind.default()],
      typecheckProject: typecheck.typecheckProject,
    };
  })().catch((err: unknown) => {
    toolchain = null;
    throw err;
  });
  return toolchain;
}

/**
 * A failed type check's output, made readable for the coding agent: scratch
 * paths scrubbed, then the fixing idioms attached.
 *
 * Both gates that run `typecheckProject` — the build and the post-write check —
 * owe the agent the identical treatment, and each spelled the two calls out for
 * itself, so a change to either half had two places to land.
 */
function annotateTypeErrors(output: string, dir: string): Promise<string> {
  return annotateDiagnostics(scrubDir(output, dir), moduleExports(dir));
}

/**
 * Build a materialized workspace directory into deploy artifacts.
 *
 * `configFile: false` on both passes: a studio workspace has no
 * `vite.config.ts` (the scaffold's plugins are injected here instead), and
 * one the coding agent invents must not change how Publish builds.
 */
export async function buildWorkspaceDir(
  dir: string,
  want: { worker: boolean; client: boolean },
): Promise<GuestBuildResult> {
  let tc: Toolchain;
  try {
    tc = await loadToolchain();
  } catch (err) {
    return { buildError: `Build toolchain unavailable in this sandbox: ${errorMessage(err)}` };
  }
  // Whatever package.json declares has to be on disk before either pass reads
  // an import — the agent may have edited the manifest by hand rather than
  // through `add_dependency`. A no-op unless something is genuinely missing.
  const depWarning = await ensureWorkspaceDependencies(dir, workspaceDependencyOptions());
  // Type errors first, as their own failure: the bundlers strip types
  // unchecked, so this is the only gate that catches runtime-working-but-
  // wrong code — and the message is exactly what the coding agent needs.
  const typed = await tc.typecheckProject(dir);
  if (!typed.ok) {
    // Attach the fixing idiom to the diagnostic rather than carrying it in
    // the system prompt: it costs nothing until a build actually fails, and
    // it arrives inside the error the agent is already reading.
    return {
      buildError: withDependencyWarning(depWarning, await annotateTypeErrors(typed.output, dir)),
    };
  }
  try {
    // Sequential, not Promise.all (#864): two concurrent Rolldown passes
    // peak at roughly the SUM of their native allocations in the one
    // process a sandbox memory cap would OOM-kill mid-build. Rolldown is
    // internally multi-threaded (and the sandbox has 1 CPU of affinity
    // anyway), so serializing costs no meaningful wall clock.
    const worker = want.worker
      ? await tc.buildWorker(dir, { minify: true, configFile: false })
      : undefined;
    const clientFiles = want.client
      ? await tc.buildClient(dir, { configFile: false, plugins: tc.clientPlugins() })
      : undefined;
    // `omitUndefined`, not `...(x !== undefined && { x })`: the `&&` spelling is
    // the same idiom with the key written twice, and `guard-invariants` rule 2
    // cannot see it.
    return omitUndefined({ worker, clientFiles });
  } catch (err) {
    return { buildError: withDependencyWarning(depWarning, formatBuildFailure(err, dir)) };
  }
}

/**
 * Run only the project's tsc pass — the post-write diagnostics backend
 * (studio-write-diagnostics.ts). The same `typecheckProject` gate every
 * build runs, without paying for the bundle, annotated with the same
 * fixing-idiom hints so a write's diagnostics read exactly like a build's.
 *
 * Imports ONLY the typecheck module: it spawns the project's own `tsc` as a
 * child, so a session that never builds never pays the bundler import.
 */
export async function typecheckWorkspaceDir(
  dir: string,
): Promise<{ ok: true; skipped: boolean } | { ok: false; output: string }> {
  let typecheckProject: typeof import("@alexkroman1/aai-cli/typecheck")["typecheckProject"];
  try {
    ({ typecheckProject } = await import("@alexkroman1/aai-cli/typecheck"));
  } catch (err) {
    return {
      ok: false,
      output: `Build toolchain unavailable in this sandbox: ${errorMessage(err)}`,
    };
  }
  const typed = await typecheckProject(dir);
  return typed.ok ? typed : { ok: false, output: await annotateTypeErrors(typed.output, dir) };
}

let buildSeq = 0;

/**
 * Materialize `files` into a fresh directory under the workspaces root, run
 * `fn`, and clean up. Used by the host's `workspace/deploy` RPC (Publish) so
 * a store-snapshot build never clobbers the live chat session's workspace.
 *
 * **The directory name carries a random token as well as the counter**, because
 * `workspacesRoot()` is keyed by PID and a counter is only unique within one
 * module instance. Two instances sharing a pid — vitest's `threads` pool runs
 * every test file in a worker thread of the SAME process, each with its own
 * module registry — both hand out `build-1`, so one file's `finally` `rm -rf`
 * deletes the directory the other is still building in. The symptom is not a
 * missing file: the victim's own `process.cwd()` stops existing, and the child
 * it spawned dies inside rolldown with `ENOENT: uv_cwd`, naming nothing about
 * this. The counter stays because it keeps the names ordered and readable.
 */
export async function withBuildDir<T>(
  files: Record<string, string>,
  materialize: (dir: string, files: Record<string, string>) => Promise<void>,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = path.join(workspacesRoot(), `build-${++buildSeq}-${randomUUID().slice(0, 8)}`);
  await mkdir(dir, { recursive: true });
  try {
    await materialize(dir, files);
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Format a Vite/Rollup failure for the chat and the UI, scrubbed of the
 * build-dir prefix and ANSI codes — the coding agent only knows
 * workspace-relative paths, so an absolute scratch path is noise it might
 * try to "fix". (Guest port of the old host-side formatBuildFailure.)
 */
export function formatBuildFailure(err: unknown, dir: string): string {
  const e = err as { message?: string; id?: string; loc?: { file?: string; line?: number } };
  const file = e?.loc?.file ?? e?.id;
  const where = file ? `${path.basename(file)}${e.loc?.line ? `:${e.loc.line}` : ""}: ` : "";
  return scrubDir(`Build failed:\n${where}${e?.message ?? String(err)}`, dir);
}

/** Strip build-dir paths and ANSI codes from a diagnostic (also used by
 * the publish module for `aai deploy` output). */
export function scrubDir(message: string, dir: string): string {
  const forms = [dir, path.relative(process.cwd(), dir)].filter(Boolean);
  let out = stripVTControlCharacters(message);
  for (const form of forms) {
    out = out.split(`${form}${path.sep}`).join("").split(form).join(".");
  }
  return out;
}

/** The .d.ts a package points at, from `types` or its `.` export. */
function typesEntry(pkg: {
  types?: string;
  exports?: Record<string, { types?: string } | string>;
}): string | undefined {
  if (pkg.types) return pkg.types;
  const root = pkg.exports?.["."];
  return typeof root === "object" ? root.types : undefined;
}

/** Exported names declared in a .d.ts, both declaration and `export {}` forms. */
function exportedNamesFromDts(dts: string): string[] {
  const names = new Set<string>();
  const decl =
    /export\s+(?:declare\s+)?(?:type|interface|const|function|class)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of dts.matchAll(decl)) if (m[1]) names.add(m[1]);
  for (const m of dts.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of (m[1] ?? "").split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return [...names];
}

/**
 * Exported names of a bare specifier, as seen from the workspace.
 *
 * Reads the package's .d.ts rather than importing it: the names the agent
 * gets wrong are usually TYPES (`ToolContext`), which have no runtime
 * presence, so `Object.keys(await import(...))` would miss exactly the ones
 * that matter. Best-effort — an unresolvable module yields no list and the
 * diagnostic goes out unannotated.
 */
function moduleExports(dir: string): ExportResolver {
  return async (specifier) => {
    try {
      // `createRequire().resolve` has no async form and stays sync; both READS
      // are async, because this runs in the process that also paces live voice
      // audio and a `.d.ts` is not a small file.
      const require = createRequire(path.join(dir, "package.json"));
      const pkgPath = require.resolve(`${specifier}/package.json`);
      const entry = typesEntry(JSON.parse(await readFile(pkgPath, "utf-8")));
      if (!entry) return [];
      return exportedNamesFromDts(await readFile(path.join(path.dirname(pkgPath), entry), "utf-8"));
    } catch {
      // Unresolvable module: the diagnostic goes out unannotated.
      return [];
    }
  };
}
