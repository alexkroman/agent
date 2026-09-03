// Copyright 2026 the AAI authors. MIT license.
/**
 * The gate on the suites that need a REAL Postgres.
 *
 * The scenario suites here assert PostgreSQL semantics their unit tiers can
 * only assert in prose: advisory-lock ownership across sessions, the platform
 * migration and the stores over it, RLS, and the driver↔Postgres encoding seam.
 * Each of them opened with its own copy of
 * `const d = PG_URL ? describe : describe.skip`, and the comment above that
 * line usually said the suite must not become "one of the checks that exists
 * without running". Nothing made that true:
 *
 * - **Locally the tier is silently absent.** `pnpm test:scenario` with no
 *   `AAI_TEST_PG_URL` prints a normal green run with those files reporting
 *   skipped tests, so the ONLY tier that can see a driver-level bug is the one
 *   nobody notices not running. That is not a hypothetical failure mode: the
 *   bug `jsonb-encoding.scenario.test.ts` exists for — a jsonb value written
 *   through both `::jsonb` and `JSON.stringify`, so it round-trips
 *   double-encoded — is invisible to every in-memory fake, because a fake holds
 *   JS values and cannot be more strict than the driver beneath it.
 * - **In CI a dropped variable is also green.** The Linux leg starts the
 *   runner's cluster and exports the URL through `$GITHUB_ENV`; if that step's
 *   plumbing broke, all five suites would skip and the job would pass. The
 *   `pg_isready` fail-fast covers the server not starting, not the variable not
 *   arriving.
 *
 * So: `describeWithPg` is the one spelling, a skip prints how to get a
 * database, and `AAI_REQUIRE_PG` turns a skip into a hard failure — which is
 * what CI's Linux leg sets, so "the wiring broke" is a red job rather than a
 * quiet one. `AAI_REQUIRE_PG` is declared in the `check:scenario` task's
 * `env` in `turbo.json`; without that, turbo's strict env mode would strip it
 * and the enforcement would silently do nothing.
 *
 * **Both gates are FUNCTIONS, and the enforcement lives inside them rather than
 * in this module's body.** It used to warn-or-throw at import time, which made
 * the gate a property of *importing this file* instead of a property of using
 * it — and `test-utils.ts` re-exports from here, so all 49 unit test files that
 * import the package's test surface tripped it: `vitest run auth.test.ts`
 * printed the "real-Postgres suite not run" banner over a file containing no
 * such suite, and `AAI_REQUIRE_PG=1 vitest run auth.test.ts` FAILED two of
 * three files over a database none of them touches. That is the same
 * false-signal shape the gate exists to prevent, pointed the other way. The
 * "it fails the FILE" intent survives intact, because a suite calls its gate at
 * the top level of its own module: the file that asks for a database is the
 * file that fails without one.
 *
 * ```sh
 * pnpm test:pg                    # resolve a local database, then run the tier
 * AAI_TEST_PG_URL=… pnpm --filter aai-server test:scenario
 * ```
 */

import { describe } from "vitest";

/**
 * `describe.skip` as a VALUE.
 *
 * Biome's `noSkippedTests` flags the `describe.skip(…)` call form, and this
 * file is the one place in the repo where skipping is the whole product — so
 * the gates reference it the way the ternaries they replaced did
 * (`PG_URL ? describe : describe.skip`) rather than reaching for a suppression.
 */
const skipSuite = describe.skip;

/**
 * The test database, or `undefined` when none is configured.
 *
 * Prefer `describeWithPg` + `pgUrl()`, or `describeWithStack` + `stackEnv()`
 * for anything needing the whole Supabase stack.
 */
export const PG_URL: string | undefined = process.env.AAI_TEST_PG_URL;

/** Set by CI's Linux integration leg: a skip here means the wiring broke. */
const REQUIRED = (process.env.AAI_REQUIRE_PG ?? "") !== "";

const HOW_TO =
  "Set AAI_TEST_PG_URL, or run `pnpm test:pg` (it finds a local Postgres — the\n" +
  "Supabase stack on 54322, or a server on 5432 — and prints how to start one\n" +
  "if there is none).";

/** One announcement per gate per file, however many suites that file declares. */
let pgAnnounced = false;

/**
 * `describe` when a database is configured, `describe.skip` otherwise — with
 * the skip announced rather than folded into a green summary.
 *
 * Under `AAI_REQUIRE_PG` a skip THROWS instead. The throw happens where this is
 * called, which is the top level of the calling suite's own module, so it fails
 * that FILE — the one outcome a green-but-skipped suite cannot be confused
 * with — and no file that merely imports the package's test surface is touched.
 */
export function describeWithPg(name: string, body: () => void): void {
  if (PG_URL) {
    describe(name, body);
    return;
  }
  if (REQUIRED) {
    throw new Error(
      `AAI_REQUIRE_PG is set but AAI_TEST_PG_URL is not, so this suite would skip.\n${HOW_TO}`,
    );
  }
  if (!pgAnnounced) {
    pgAnnounced = true;
    console.warn(`\n[skipped: no AAI_TEST_PG_URL] real-Postgres suite not run.\n${HOW_TO}\n`);
  }
  skipSuite(name, body);
}

/**
 * The database URL as a plain `string`, for use inside a `describeWithPg` body.
 *
 * This exists to delete the `PG_URL as string` that every one of these suites
 * carried at least once: the cast is correct exactly where the guard has
 * already run and unchecked everywhere else, which is what a narrowing helper
 * is for. Called outside the guard it throws naming the mistake instead of
 * handing a connection helper `undefined`.
 */
export function pgUrl(): string {
  if (!PG_URL) {
    throw new Error("pgUrl() read with no AAI_TEST_PG_URL — call it inside describeWithPg.");
  }
  return PG_URL;
}

/** Everything a stack-gated suite needs; all three or nothing (see {@link STACK}). */
export type StackEnv = { url: string; serviceKey: string; anonKey: string };

/**
 * The whole local Supabase stack, or `undefined` when only a database is
 * configured.
 *
 * **A plain Postgres is not an arm for anything in `aai_platform`**, and that is
 * the distinction this second gate exists to make. Vault, pg_cron, pg_net,
 * walrus/Realtime, Storage and Auth are all Supabase's, and nothing anywhere
 * runs the platform schema without them — so a stock server is a deployment
 * nobody has, and a suite that ran against one would be asserting about a shape
 * production never had. The stack is the ONE real arm for those contracts, which
 * is why its absence has to be loud: with no fallback arm this gate is the only
 * thing standing between "the platform tier ran" and "the platform tier was
 * absent", so it carries more weight than `describeWithPg` ever did.
 *
 * **The ANON key is part of the conjunction, not an extra.** It was optional
 * here, which put a stack missing only that key on the wrong side of the line:
 * `describeWithStack` said "the stack is in reach", the suite ran, and the one
 * spec that needs an anon authority (`realtime-rls.scenario.test.ts` — RLS is
 * only observable from a role RLS applies to) failed on an `undefined` key. A
 * gate exists to answer "can this arm run", and an arm that cannot run its own
 * assertions has to be an ANNOUNCED SKIP, never a red test. Everything that
 * resolves a stack resolves all three together — `pnpm test:pg` exports the trio
 * out of `supabase status -o env`, and `turbo.json` declares all three under
 * `check:scenario` — so requiring it costs no caller anything.
 */
const STACK = ((): StackEnv | undefined => {
  const url = process.env.AAI_TEST_SUPABASE_URL;
  const serviceKey = process.env.AAI_TEST_SUPABASE_SERVICE_KEY;
  const anonKey = process.env.AAI_TEST_SUPABASE_ANON_KEY;
  if (!(PG_URL && url && serviceKey && anonKey)) return;
  return { url, serviceKey, anonKey };
})();

/** Set by `pnpm test:pg` when it really resolved a stack, and by CI's stack leg. */
const STACK_REQUIRED = (process.env.AAI_REQUIRE_STACK ?? "") !== "";

const HOW_TO_STACK =
  "Run `pnpm test:pg` with the local stack up: it shells out to `supabase status\n" +
  "-o env` and exports AAI_TEST_SUPABASE_URL / _SERVICE_KEY / _ANON_KEY beside\n" +
  "AAI_TEST_PG_URL. Start one with `supabase start` (it applies\n" +
  "supabase/migrations on init; `supabase migration up` catches up an old one).";

/** One announcement per gate per file, however many suites that file declares. */
let stackAnnounced = false;

/**
 * `describe` with the local Supabase stack in reach, `describe.skip` otherwise —
 * announced rather than folded into a green summary.
 *
 * The one spelling for this gate, in place of the hand-rolled conjunction
 * (`PG_URL && SB_URL && SB_SERVICE_KEY ? describe : describe.skip`) that
 * `realtime-rls.scenario.test.ts` carried while nothing in the repo resolved
 * those three values together.
 *
 * Same shape as {@link describeWithPg}: under `AAI_REQUIRE_STACK` a skip throws
 * from the CALL, so it fails the suite's own file and leaves every other
 * importer of the package's test surface alone.
 */
export function describeWithStack(name: string, body: () => void): void {
  if (STACK) {
    describe(name, body);
    return;
  }
  if (STACK_REQUIRED) {
    throw new Error(
      "AAI_REQUIRE_STACK is set but the Supabase stack is not configured, so this suite " +
        `would skip.\n${HOW_TO_STACK}`,
    );
  }
  if (!stackAnnounced) {
    stackAnnounced = true;
    console.warn(
      `\n[skipped: no local Supabase stack] platform-arm suite not run.\n${HOW_TO_STACK}\n`,
    );
  }
  skipSuite(name, body);
}

/**
 * The stack's values, for use inside a `describeWithStack` body.
 *
 * Same narrowing contract as `pgUrl()`: correct exactly where the guard has run,
 * and throwing rather than handing a Realtime client an `undefined` key
 * everywhere else. Note vitest EXECUTES a `describe.skip` callback to enumerate
 * what it is skipping, so read this inside a hook or a test — never at the top
 * of a gated `describe` body, where it fails the file instead of skipping it.
 *
 * `anonKey` is non-optional: see {@link STACK}. A caller past the gate holds all
 * three, so an RLS spec needs no second guard of its own.
 */
export function stackEnv(): StackEnv {
  if (!STACK) {
    throw new Error("stackEnv() read with no Supabase stack — call it inside describeWithStack.");
  }
  return STACK;
}
