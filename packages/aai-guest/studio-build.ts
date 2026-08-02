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
 * **The bundler runs in a ONE-SHOT CHILD PROCESS** (`studio-build-child.ts`,
 * spawned via `harnessEntry()`), for one reason: Rolldown does its work in
 * Rust, outside V8, and never returns that memory to the OS. Measured in a
 * production sandbox, a single in-process `buildWorker` took the harness from
 * 258 MB to 1.7 GB RSS — of which V8's heap was 51 MB — and because the
 * harness is long-lived and reused across `test_agent` calls, that peak
 * became the floor and climbed with every build (1.7 → 2.1 → 2.2 GB).
 * `global.gc()` recovered 75 MB and `MALLOC_ARENA_MAX=2` recovered 35 MB, so
 * neither GC nor allocator tuning is a fix; process exit is. Publish already
 * had this shape (it spawns the literal CLI — see studio-publish.ts), so this
 * makes the two build paths agree. Keep the bundler out of this process.
 *
 * The toolchain is NOT bundled into the harness: it resolves at runtime
 * from the `node_modules` that live next to the harness — baked into the
 * guest snapshot image in production (see aai-server's
 * modal-harness-image.ts), this package's own dependencies in dev/tests.
 * Workspaces are materialized under the same root so their bare imports
 * (`@alexkroman1/aai`, `zod`, `@alexkroman1/aai-ui`, `react`) resolve by
 * the normal node_modules walk-up, exactly as in a user project.
 */

import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { errMsg } from "./harness-rpc.ts";
import type { ExportResolver } from "./studio-diagnostics.ts";
import { CLI_OUTPUT_CAP, parseLastJsonLine, pathOnlyEnv, runCapped } from "./studio-spawn.ts";

/** Result of one guest build; `buildError` is prose the coding agent can act on. */
export type GuestBuildResult = {
  worker?: string;
  clientFiles?: Record<string, string>;
  buildError?: string;
};

/** Wall-clock backstop for one build child (typecheck gate + bundle). */
const BUILD_TIMEOUT_MS = 240_000;

/** Argv flag that puts the harness entry into build-child mode. */
export const BUILD_CHILD_FLAG = "--build-workspace";

/**
 * Root under which workspaces materialize: a dot-directory next to this
 * module (→ next to the bundled harness.mjs), because that location — and
 * only that location — has the toolchain's `node_modules` above it.
 */
export function workspacesRoot(): string {
  return path.join(import.meta.dirname, ".workspaces");
}

/**
 * The script to spawn for a build child — the harness entry itself, which
 * dispatches on `BUILD_CHILD_FLAG` instead of starting its server.
 *
 * Reusing the harness entry rather than shipping a second script is what
 * keeps the guest ONE artifact: tsdown emits a single `harness.mjs` with
 * `inlineDynamicImports`, and aai-server's modal-harness-image.ts bakes
 * exactly that one file. Bundled, this module IS that entry, so
 * `import.meta.url` already points at it; from TypeScript source (dev,
 * tests) the entry is its sibling `harness.ts`, which Node runs directly
 * (the repo is `erasableSyntaxOnly`).
 */
export function harnessEntry(): string {
  const self = fileURLToPath(import.meta.url);
  return path.basename(self).startsWith("studio-build")
    ? path.join(path.dirname(self), "harness.ts")
    : self;
}

/** The build child's one-line stdout result, mirroring the CLI's `--json`. */
export type BuildEnvelope =
  | { ok: true; worker?: boolean; client?: boolean }
  | { ok: false; buildError: string };

/**
 * Build a materialized workspace directory into deploy artifacts, in a
 * one-shot child process (see this module's header for why).
 *
 * Artifacts come back through a scratch directory rather than stdout: the
 * worker bundle runs to ~8 MB, which JSON-escaping would roughly double in
 * transit and buffer twice. The scratch dir lives outside the workspace so
 * it can never be picked up by the end-of-turn `studio/sync-workspace`.
 */
export async function buildWorkspaceDir(
  dir: string,
  want: { worker: boolean; client: boolean },
  opts: { /** Test seam: entry script spawned instead of the harness. */ buildEntry?: string } = {},
): Promise<GuestBuildResult> {
  const out = await mkdtemp(path.join(tmpdir(), "aai-build-out-"));
  try {
    const result = await runCapped(
      process.execPath,
      [
        opts.buildEntry ?? harnessEntry(),
        BUILD_CHILD_FLAG,
        dir,
        "--out",
        out,
        ...(want.worker ? ["--worker"] : []),
        ...(want.client ? ["--client"] : []),
      ],
      // Nothing from this process's env: the build needs no credentials,
      // and the guest's bearer token must not reach it.
      { cwd: dir, env: pathOnlyEnv(), timeoutMs: BUILD_TIMEOUT_MS, cap: CLI_OUTPUT_CAP },
    );
    if (result.signal) {
      throw new Error(`build killed by ${result.signal} after ${BUILD_TIMEOUT_MS}ms`);
    }
    const envelope = parseLastJsonLine<BuildEnvelope>(result.stdout);
    if (envelope === null) {
      // The child died before reporting (OOM, a crash in the bundler's
      // native half) — surface everything, since nothing else will.
      return {
        buildError: scrubDir(
          `Build process exited with ${result.exitCode}\n${result.stdout.trim()}\n${result.stderr.trim()}`.trim(),
          dir,
        ),
      };
    }
    if (!envelope.ok) return { buildError: envelope.buildError };
    return {
      ...(envelope.worker && { worker: await readFile(path.join(out, "worker.mjs"), "utf-8") }),
      ...(envelope.client && {
        clientFiles: JSON.parse(await readFile(path.join(out, "client.json"), "utf-8")) as Record<
          string,
          string
        >,
      }),
    };
  } catch (err) {
    return { buildError: `Build failed to run: ${errMsg(err)}` };
  } finally {
    await rm(out, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Run only the project's tsc pass — the `check_types` tool's backend. The
 * same `typecheckProject` gate every build runs, without paying for the
 * bundle, so the coding agent can iterate on type errors cheaply.
 *
 * Stays in-process, and imports ONLY the typecheck module: it spawns the
 * project's own `tsc` as a child, so the memory that matters is already
 * outside this process. Do not widen this to the bundler toolchain —
 * importing Vite/Rolldown here would put ~90 MB and ~29 threads into the
 * harness permanently, for a tool that never bundles.
 */
export async function typecheckWorkspaceDir(
  dir: string,
): Promise<{ ok: true; skipped: boolean } | { ok: false; output: string }> {
  let typecheckProject: typeof import("@alexkroman1/aai-cli/typecheck")["typecheckProject"];
  try {
    ({ typecheckProject } = await import("@alexkroman1/aai-cli/typecheck"));
  } catch (err) {
    return { ok: false, output: `Build toolchain unavailable in this sandbox: ${errMsg(err)}` };
  }
  const typed = await typecheckProject(dir);
  return typed.ok ? typed : { ok: false, output: scrubDir(typed.output, dir) };
}

let buildSeq = 0;

/**
 * Materialize `files` into a fresh directory under the workspaces root, run
 * `fn`, and clean up. Used by the host's `workspace/deploy` RPC (Publish) so
 * a store-snapshot build never clobbers the live chat session's workspace.
 */
export async function withBuildDir<T>(
  files: Record<string, string>,
  materialize: (dir: string, files: Record<string, string>) => Promise<void>,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = path.join(workspacesRoot(), `build-${process.pid}-${++buildSeq}`);
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
export function moduleExports(dir: string): ExportResolver {
  return (specifier) => {
    try {
      const require = createRequire(path.join(dir, "package.json"));
      const pkgPath = require.resolve(`${specifier}/package.json`);
      const entry = typesEntry(JSON.parse(readFileSync(pkgPath, "utf-8")));
      if (!entry) return [];
      return exportedNamesFromDts(readFileSync(path.join(path.dirname(pkgPath), entry), "utf-8"));
    } catch {
      // Unresolvable module: the diagnostic goes out unannotated.
      return [];
    }
  };
}
