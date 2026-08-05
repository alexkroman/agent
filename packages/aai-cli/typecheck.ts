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
 *
 * @internal — build hook for aai-server/the studio; not a supported public
 * API and not covered by semver. The lack of a `_` prefix is packaging (the
 * subpath must be importable cross-package), not an invitation: user code
 * should never import from `@alexkroman1/aai-cli`.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
// Zod-free imports only — this module is the `/typecheck` subpath the guest
// sandbox loads, so it must stay light (no build toolchain, no zod).
import { binFromPackageJson, errorMessage } from "./_utils.ts";

/** Bound on one typecheck run — a hung compiler must not wedge a deploy. */
const TYPECHECK_TIMEOUT_MS = 120_000;
/** Diagnostics tail kept for the failure message. */
const OUTPUT_CAP = 16_000;

/**
 * Outcome of one {@link typecheckProject} run — a discriminated union on
 * `ok`: `{ ok: true, skipped }` when the check passed (`skipped: true`
 * meaning the project has no `tsconfig.json` so nothing ran), or
 * `{ ok: false, output }` with the formatted tsc diagnostics (tail-capped)
 * ready to surface as build feedback.
 *
 * @internal — build hook for aai-server/the studio; not a supported public
 * API and not covered by semver.
 */
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

/**
 * Resolve the project's TypeScript compiler entry (its own `tsc` bin), plus
 * its major version — see {@link tscArgs} for what the version decides.
 */
function resolveTsc(cwd: string): { entry: string; major: number } {
  const dir = findTypescriptPackage(cwd);
  if (dir === undefined) throw new Error("no typescript package in the project's node_modules");
  const manifest = path.join(dir, "package.json");
  const bin = binFromPackageJson(manifest, "tsc");
  if (!bin) throw new Error("installed typescript package declares no tsc bin");
  return { entry: bin, major: readMajor(manifest) };
}

/**
 * The resolved compiler's major version, or 0 when it can't be read.
 *
 * 0 is the safe answer: {@link tscArgs} only ADDS flags above a version
 * floor, so an unreadable manifest degrades to the flag set every TypeScript
 * accepts rather than failing a build over a cosmetic read.
 */
function readMajor(manifest: string): number {
  try {
    const { version } = JSON.parse(readFileSync(manifest, "utf-8")) as { version?: unknown };
    return typeof version === "string" ? Number.parseInt(version, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

/**
 * The `tsc` argv for one project check.
 *
 * `--singleThreaded` is the interesting one, and it is a SPEEDUP here rather
 * than a throttle. TypeScript 7 parallelizes parse/check/emit by default,
 * which pays off on a repo-sized program and costs on a single agent project —
 * and this function only ever checks one of those. Measured on the templates
 * project (14 agents, the closest in-repo analogue of a studio workspace):
 *
 * - pinned to 1 core: 2.4–2.9s parallel vs 1.2–1.4s single — ~2x faster
 * - on 4 cores:       1.21–1.24s parallel vs 1.01–1.04s single
 *
 * The 1-core number is the one that matters: a guest sandbox RESERVES one CPU
 * (`SANDBOX_CPU`) and this same check runs after every settled write burst in
 * the studio (`aai-guest/studio-write-diagnostics.ts`), where the whole design
 * rests on it finishing in well under a second. Parallelism inside a one-core
 * reservation is oversubscription: the threads exist, contend, and the wall
 * clock doubles.
 *
 * Gated on major >= 7 because the flag is TS 7's, and an unknown compiler
 * option is a HARD error (TS5023) — a project pinning an older TypeScript
 * would fail its build on a flag it never asked for. `engines`/scaffold pin
 * `^7`, so in practice this floor is always met; it exists so a project that
 * pins otherwise degrades instead of breaking.
 */
function tscArgs(entry: string, major: number): string[] {
  return [entry, "--noEmit", "--pretty", "false", ...(major >= 7 ? ["--singleThreaded"] : [])];
}

/**
 * Typecheck the project at `cwd` with its own tsconfig + compiler.
 * Skips (ok, skipped: true) when the project has no tsconfig.json.
 *
 * @internal — build hook for aai-server/the studio; not a supported public
 * API and not covered by semver.
 */
export async function typecheckProject(cwd: string): Promise<TypecheckResult> {
  if (!existsSync(path.join(cwd, "tsconfig.json"))) return { ok: true, skipped: true };

  let tsc: { entry: string; major: number };
  try {
    tsc = resolveTsc(cwd);
  } catch (err) {
    return {
      ok: false,
      output:
        "tsconfig.json is present but TypeScript is not installed — " +
        `add it (npm install -D typescript) or remove tsconfig.json: ${errorMessage(err)}`,
    };
  }

  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, tscArgs(tsc.entry, tsc.major), {
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
