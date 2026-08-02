// Copyright 2026 the AAI authors. MIT license.
/**
 * Project typechecking — `tsc --noEmit` over the project's own tsconfig.
 *
 * Public (no `_` prefix) for the same reason as the bundlers: the guest
 * sandbox runs the same check before `test_agent` builds, so the studio's
 * coding agent sees type errors as build feedback instead of shipping
 * runtime-working-but-wrong code (the bundlers strip types unchecked —
 * excess-property bugs like `send`/`state` shipped exactly that way).
 *
 * Gated on `tsconfig.json`: a project that declares its type discipline is
 * checked with it; one that doesn't isn't (scaffolded projects and studio
 * workspaces always have one). TypeScript itself resolves from the
 * PROJECT'S node_modules — the user's pinned compiler, not ours.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
// Zod-free imports only — this module is the `/typecheck` subpath the guest
// sandbox loads, so it must stay light (no build toolchain, no zod).
import { binFromPackageJson, errorMessage } from "./_utils.ts";

/** Bound on one typecheck run — a hung compiler must not wedge a deploy. */
const TYPECHECK_TIMEOUT_MS = 120_000;
/** Diagnostics tail kept for the failure message. */
const OUTPUT_CAP = 16_000;

export type TypecheckResult = { ok: true; skipped: boolean } | { ok: false; output: string };

/**
 * The project's own TypeScript package root — `node_modules/typescript`,
 * walking up from `cwd` exactly as a bare import would.
 *
 * Deliberately NOT `require.resolve("typescript")`. Node appends
 * `Module.globalPaths` — `NODE_PATH`, `~/.node_modules`, the install prefix —
 * to EVERY lookup, and the `paths` option does not suppress them, so an
 * ambient TypeScript anywhere on the host silently satisfies a project that
 * never declared one. That breaks the promise in this module's header twice
 * over: the gate would check a user's build with a compiler their project
 * doesn't pin, and the "TypeScript is not installed" branch below would be
 * unreachable on any host that sets NODE_PATH — which is how vitest runs its
 * workers (it points NODE_PATH at pnpm's hidden store), so the test for that
 * branch could not fail honestly either.
 *
 * The walk-up follows symlinks, which is what pnpm's `node_modules/typescript
 * -> .pnpm/typescript@x/node_modules/typescript` link needs, and what lets a
 * guest sandbox workspace reach the toolchain baked next to the harness.
 */
function findTypescriptPackage(cwd: string): string | undefined {
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, "node_modules", "typescript");
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/** Resolve the project's TypeScript compiler entry (its own `tsc` bin). */
function resolveTscEntry(cwd: string): string {
  const dir = findTypescriptPackage(cwd);
  if (dir === undefined) throw new Error("no typescript package in the project's node_modules");
  const bin = binFromPackageJson(path.join(dir, "package.json"), "tsc");
  if (!bin) throw new Error("installed typescript package declares no tsc bin");
  return bin;
}

/**
 * Typecheck the project at `cwd` with its own tsconfig + compiler.
 * Skips (ok, skipped: true) when the project has no tsconfig.json.
 */
export async function typecheckProject(cwd: string): Promise<TypecheckResult> {
  if (!existsSync(path.join(cwd, "tsconfig.json"))) return { ok: true, skipped: true };

  let tscEntry: string;
  try {
    tscEntry = resolveTscEntry(cwd);
  } catch (err) {
    return {
      ok: false,
      output:
        "tsconfig.json is present but TypeScript is not installed — " +
        `add it (npm install -D typescript) or remove tsconfig.json: ${errorMessage(err)}`,
    };
  }

  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [tscEntry, "--noEmit", "--pretty", "false"], {
      cwd,
      timeout: TYPECHECK_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const keep = (s: string) => (s.length > OUTPUT_CAP ? `…${s.slice(-OUTPUT_CAP)}` : s);
    child.stdout.on("data", (chunk: Buffer) => {
      output = keep(output + chunk.toString());
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output = keep(output + chunk.toString());
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) {
        reject(new Error(`tsc killed by ${signal} after ${TYPECHECK_TIMEOUT_MS}ms`));
        return;
      }
      resolve({ code, output });
    });
  });

  if (result.code === 0) return { ok: true, skipped: false };
  return { ok: false, output: `Type check failed:\n${result.output.trim()}` };
}
