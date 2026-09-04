/**
 * Read the local Supabase stack's own values out of `supabase status -o env`.
 *
 * Two callers want the same parse and neither may guess at the values: the keys
 * are stable, but the JWTs and the `sb_secret_…`/`sb_publishable_…` pair are the
 * CLI's to mint, and a hand-copied set is a thing that rots silently. That is
 * the whole argument for shelling out rather than hardcoding
 * `http://127.0.0.1:54321` plus a checked-in key — the failure mode of the
 * hardcoded version is a stack that answers with an unusable credential, which
 * both callers then report as something else (a skipped test tier; a server
 * quietly on memory stores).
 *
 * - `scripts/with-test-pg.mjs` forwards the trio the scenario tier's
 *   `describeWithStack` gate reads.
 * - `scripts/dev-server.mjs` forwards the platform env `buildPlatformDb` reads,
 *   so `pnpm dev:aai-server` is durable without anyone exporting five variables
 *   by hand.
 *
 * It RESOLVES a stack and deliberately never starts one: `supabase start` costs
 * minutes and gigabytes, which is a decision the person at the keyboard owns.
 *
 * Every way this can fail — no CLI on PATH, a stack that is down, output this
 * cannot parse — resolves to `{ why }` with a reason its caller can print. It
 * must never throw: both callers have a narrower arm that is legitimate, and a
 * resolver that aborted the run would take that away.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

/** The repo root, where `supabase status` finds `supabase/config.toml`. */
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/** `KEY="value"` per line, which is the whole of the `-o env` format. */
const LINE = /^([A-Z0-9_]+)="?(.*?)"?$/;

/**
 * The stack's values as a `Map`, or `{ why }`.
 *
 * The MAP rather than a selected shape, because the two callers select
 * differently and neither should have to know the other's keys. What neither may
 * do is forward the whole thing: the output also carries the JWT secret and the
 * S3 credential pair, and a caller that exported everything would be putting
 * them in the environment of a child process that has no use for them.
 *
 * Each arm declares the OTHER arm's keys as absent, which is what makes
 * `if (!stack.values)` a real narrowing rather than a property read that
 * happens to be `undefined` at runtime. Both callers were written that way and
 * neither could be checked: on a bare two-arm union every member access is an
 * error, so the compiler could not tell the success path from the failure path
 * — in a resolver whose entire contract is that its failure path stays
 * reachable and prints a reason.
 *
 * @returns {{ values: Map<string, string>, source: string, why?: undefined }
 *   | { values?: undefined, source?: undefined, why: string }}
 */
export function readSupabaseStack() {
  const run = spawnSync("supabase", ["status", "-o", "env"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    // stderr carries a "Stopped services" line and a CLI update notice on a
    // perfectly healthy stack, so it is noise here rather than a signal; the
    // exit code and the parse are what decide.
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (run.error || run.status !== 0) {
    // `spawnSync` types `error` as a plain `Error`; what node actually throws
    // here is an `ErrnoException`, and the errno is the whole distinction
    // between "no CLI installed" and "the stack is down".
    const notFound =
      run.error instanceof Error && "code" in run.error && run.error.code === "ENOENT";
    const why = notFound ? "no `supabase` CLI on PATH" : "the command failed";
    return { why: `could not read \`supabase status -o env\` (${why})` };
  }
  const values = new Map(
    run.stdout
      .split("\n")
      .map((line) => LINE.exec(line.trim()))
      .filter((m) => m !== null)
      .map((m) => [m[1], m[2]]),
  );
  return { values, source: "supabase status -o env" };
}
