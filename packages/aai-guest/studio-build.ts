// Copyright 2026 the AAI authors. MIT license.
/**
 * Guest-side workspace builds — THE build path for studio agents.
 *
 * Builds run here, in the tenant's own sandbox, through the aai CLI's own
 * bundlers (`@alexkroman1/aai-cli/worker-bundler` + `/client-bundler`) — the
 * exact functions `aai deploy` runs on a laptop. There is no host-side or
 * out-of-process build backend anymore: one path, exercised by every
 * `test_agent` call and every Publish, so the studio and CLI builds cannot
 * diverge. A hostile or pathological workspace burns this sandbox's CPU and
 * nothing else — the container is the isolation boundary, exactly as for
 * the tools.
 *
 * The toolchain is NOT bundled into the harness: it resolves at runtime
 * from the `node_modules` that live next to the harness — baked into the
 * guest snapshot image in production (see aai-server's
 * modal-harness-image.ts), this package's own dependencies in dev/tests.
 * Workspaces are materialized under the same root so their bare imports
 * (`@alexkroman1/aai`, `zod`, `@alexkroman1/aai-ui`, `react`) resolve by
 * the normal node_modules walk-up, exactly as in a user project.
 */

import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

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
 * Root under which workspaces materialize: a dot-directory next to this
 * module (→ next to the bundled harness.mjs), because that location — and
 * only that location — has the toolchain's `node_modules` above it.
 */
export function workspacesRoot(): string {
  return path.join(import.meta.dirname, ".workspaces");
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
    return { buildError: `Build toolchain unavailable in this sandbox: ${errMessage(err)}` };
  }
  // Type errors first, as their own failure: the bundlers strip types
  // unchecked, so this is the only gate that catches runtime-working-but-
  // wrong code — and the message is exactly what the coding agent needs.
  const typed = await tc.typecheckProject(dir);
  if (!typed.ok) return { buildError: scrubDir(typed.output, dir) };
  try {
    const [worker, clientFiles] = await Promise.all([
      want.worker ? tc.buildWorker(dir, { minify: true, configFile: false }) : undefined,
      want.client
        ? tc.buildClient(dir, { configFile: false, plugins: tc.clientPlugins() })
        : undefined,
    ]);
    return {
      ...(worker !== undefined && { worker }),
      ...(clientFiles !== undefined && { clientFiles }),
    };
  } catch (err) {
    return { buildError: formatBuildFailure(err, dir) };
  }
}

let buildSeq = 0;

/**
 * Materialize `files` into a fresh directory under the workspaces root, run
 * `fn`, and clean up. Used by the host's `workspace/build` RPC (Publish) so
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

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
