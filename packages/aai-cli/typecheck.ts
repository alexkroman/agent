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
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

/** Bound on one typecheck run — a hung compiler must not wedge a deploy. */
const TYPECHECK_TIMEOUT_MS = 120_000;
/** Diagnostics tail kept for the failure message. */
const OUTPUT_CAP = 16_000;

export type TypecheckResult = { ok: true; skipped: boolean } | { ok: false; output: string };

/** Resolve the project's TypeScript compiler entry (its own `tsc` bin). */
function resolveTscEntry(cwd: string): string {
  const require = createRequire(path.join(cwd, "package.json"));
  // Resolve the package entry, then walk up to its package.json — the
  // exports map does not expose "./package.json" directly.
  let dir = path.dirname(require.resolve("typescript"));
  for (let i = 0; i < 5; i++) {
    const pkgPath = path.join(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        name?: string;
        bin?: string | Record<string, string>;
      };
      if (pkg.name === "typescript") {
        const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.tsc;
        if (!bin) throw new Error("installed typescript package declares no tsc bin");
        return path.join(dir, bin);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    dir = path.dirname(dir);
  }
  throw new Error("could not locate the installed typescript package root");
}

/**
 * Typecheck the project at `cwd` with its own tsconfig + compiler.
 * Skips (ok, skipped: true) when the project has no tsconfig.json.
 */
export async function typecheckProject(cwd: string): Promise<TypecheckResult> {
  const hasTsconfig = await readFile(path.join(cwd, "tsconfig.json"), "utf-8").then(
    () => true,
    () => false,
  );
  if (!hasTsconfig) return { ok: true, skipped: true };

  let tscEntry: string;
  try {
    tscEntry = resolveTscEntry(cwd);
  } catch (err) {
    return {
      ok: false,
      output:
        "tsconfig.json is present but TypeScript is not installed — " +
        `add it (npm install -D typescript) or remove tsconfig.json: ${errMessage(err)}`,
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

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
