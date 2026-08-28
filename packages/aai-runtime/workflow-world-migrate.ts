// Copyright 2026 the AAI authors. MIT license.
/**
 * Running the Postgres world's migration from inside a server, and classifying
 * what an operator asked for.
 *
 * Split out of `workflow-world.ts` when the platform-queue composition pushed that
 * file past its length cap. The seam holds on its own: everything here is about the
 * DevKit's own CLI and the specifier an operator supplied, while what is left there
 * is which world this guest runs and when it starts. This half is edited when the
 * DevKit's CLI changes; that half when the platform does.
 */

import { POSTGRES_WORLD, type WorldKind } from "./workflow-world-kind.ts";

/**
 * What an operator-supplied `WORKFLOW_TARGET_WORLD` is, for MIGRATION purposes.
 *
 * The DevKit loads whatever specifier it is given; this only has to answer "does
 * that thing need `setupDatabase` run against it first". It used to be
 * `supplied === POSTGRES_WORLD`, i.e. an exact match on the bare package name —
 * so every other spelling of the SAME world was classified `local` and therefore
 * never migrated, while the DevKit went on loading it. That is a Postgres world
 * pointed at an unmigrated database, and the log says `local`, which is the
 * hardest possible starting point for whoever debugs it. It is not theoretical:
 * a resolved absolute path (the ordinary way to pin a world in a pnpm workspace,
 * where the package is not visible from the project) produced exactly that —
 * `harness starting local workflow world` followed by
 * `Failed query: select … from "workflow"."workflow_runs"`.
 *
 * A substring match on the package name covers every spelling of it: the bare
 * name, a `file:`/absolute path ending in it, a version-pinned specifier, a
 * pnpm virtual-store path. A genuinely CUSTOM world still reads as `local`,
 * which is the right answer — nothing here knows how to migrate one — and it is
 * the caller's business, not a silent misreading of ours.
 */
export function classifySuppliedWorld(supplied: string): WorldKind {
  return supplied.includes(POSTGRES_WORLD) ? "postgres" : "local";
}

/**
 * Run the Postgres world's migration WITHOUT letting it end the process.
 *
 * **`setupDatabase` is `@workflow/world-postgres/cli`'s own entry point, and it
 * behaves like one: `process.exit(0)` on success, `process.exit(1)` on failure.**
 * So awaiting it from a server is not "migrate, then carry on" — it is "migrate,
 * then die", with a SUCCESS code, before anything listens. That is not a
 * hypothetical: `aai dev` against a project with a `DATABASE_URL` printed
 * `✅ Database schema created successfully!` and exited 0, and a deployed guest
 * does the same thing at `harness-agent-mode.ts`'s world start, which runs
 * BEFORE `server.listen` — so the platform's readiness poll never gets an
 * answer and the spawn fails. Every agent that declares workflows AND has
 * storage was on that path, which is the configuration
 * `transcription-workflow` documents as the right one.
 *
 * `startWorkflowWorldIfDeclared`'s try/catch cannot help, either: an exit is not
 * an exception, so the "a failure must not take the guest down" rule it exists
 * to enforce was unenforceable.
 *
 * **The stand-in RECORDS and RETURNS; it does not throw.** `process.exit` is the
 * LAST statement in both of `setupDatabase`'s branches, after its `pool.end()` —
 * so returning simply lets the function fall out of the branch it is in and
 * resolve, with nothing left half-done and nothing after it to run.
 *
 * It threw at first, and a throw is what made this loud in the wrong direction:
 * the exception landed in `setupDatabase`'s OWN `catch`, which logged
 * `❌ Failed to setup database: <our sentinel>` with a stack trace and exited
 * again — directly under `✅ Database schema created successfully!`, on the happy
 * path, on every workflow guest boot. Suppressing that line was the first fix and
 * the wrong one: it needed a sentinel class, an outer catch, an "ignore the
 * second exit code" rule, and a `console.error` filter, all to undo a reaction to
 * our own interception. Not throwing means none of that exists.
 *
 * A REAL failure is unaffected: its `catch` has already run (pool closed, the
 * genuine error logged as itself), `exitCode` is 1, and the check below turns
 * that into an exception the caller reports.
 *
 * A version that stops exiting needs no change here either — returning normally
 * is read as success either way.
 *
 * Not a general-purpose wrapper, deliberately. It is installed for the duration
 * of ONE call at boot, where nothing else in the process is trying to exit.
 */
export async function migratePostgresWorld(): Promise<void> {
  const { setupDatabase } = await import("@workflow/world-postgres/cli");
  const realExit = process.exit;
  let exitCode: number | undefined;
  // A single assertion below, never `as unknown as`: the stub RETURNS where the
  // real `process.exit` is typed `never`, and that is the one difference. `never`
  // is assignable to `void`, so the two signatures still have to be comparable —
  // widen through `unknown` and a genuinely wrong parameter list stops being
  // reported (verified: it becomes a TS2352).
  process.exit = ((code?: number | string | null): void => {
    // FIRST exit wins. With the throw gone there is normally only one — but the
    // rule is kept because it is what makes a genuine `exit(1)` legible: whatever
    // the CLI decides FIRST is its decision, and nothing later may soften it.
    exitCode ??= typeof code === "number" ? code : 0;
  }) as typeof process.exit;
  try {
    await setupDatabase();
  } finally {
    process.exit = realExit;
  }
  // `undefined` means it returned instead of exiting, which is what a fixed
  // upstream would do. A non-zero code is a real migration failure, and it has
  // to become an exception so the caller can report it.
  if (exitCode !== undefined && exitCode !== 0) {
    throw new Error(`the Postgres world migration failed (exit ${exitCode})`);
  }
}
