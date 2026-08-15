// Copyright 2026 the AAI authors. MIT license.
/**
 * The gate on the suites that need a REAL Postgres.
 *
 * Five integration suites here assert PostgreSQL semantics their unit tiers can
 * only assert in prose: advisory-lock ownership across sessions, the platform
 * migration and the stores over it, RLS, and the driver↔Postgres encoding seam.
 * Each of them opened with its own copy of
 * `const d = PG_URL ? describe : describe.skip`, and the comment above that
 * line usually said the suite must not become "one of the checks that exists
 * without running". Nothing made that true:
 *
 * - **Locally the tier is silently absent.** `pnpm test:integration` with no
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
 * quiet one. `AAI_REQUIRE_PG` is declared in the `check:integration` task's
 * `env` in `turbo.json`; without that, turbo's strict env mode would strip it
 * and the enforcement would silently do nothing.
 *
 * ```sh
 * pnpm test:pg                    # resolve a local database, then run the tier
 * AAI_TEST_PG_URL=… pnpm --filter aai-server test:integration
 * ```
 */

import { describe } from "vitest";

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

if (!PG_URL) {
  if (REQUIRED) {
    // Thrown at import time on purpose: it fails the FILE, which is the only
    // outcome a green-but-skipped suite cannot be confused with.
    throw new Error(
      `AAI_REQUIRE_PG is set but AAI_TEST_PG_URL is not, so this suite would skip.\n${HOW_TO}`,
    );
  }
  console.warn(`\n[skipped: no AAI_TEST_PG_URL] real-Postgres suite not run.\n${HOW_TO}\n`);
}

/**
 * `describe` when a database is configured, `describe.skip` otherwise — with
 * the skip announced above rather than folded into a green summary.
 */
export const describeWithPg = PG_URL ? describe : describe.skip;

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
 */
const STACK = ((): { url: string; serviceKey: string; anonKey?: string } | undefined => {
  const url = process.env.AAI_TEST_SUPABASE_URL;
  const serviceKey = process.env.AAI_TEST_SUPABASE_SERVICE_KEY;
  if (!(PG_URL && url && serviceKey)) return;
  const anonKey = process.env.AAI_TEST_SUPABASE_ANON_KEY;
  return { url, serviceKey, ...(anonKey ? { anonKey } : {}) };
})();

/** Set by `pnpm test:pg` when it really resolved a stack, and by CI's stack leg. */
const STACK_REQUIRED = (process.env.AAI_REQUIRE_STACK ?? "") !== "";

const HOW_TO_STACK =
  "Run `pnpm test:pg` with the local stack up: it shells out to `supabase status\n" +
  "-o env` and exports AAI_TEST_SUPABASE_URL / _SERVICE_KEY / _ANON_KEY beside\n" +
  "AAI_TEST_PG_URL. Start one with `supabase start` (it applies\n" +
  "supabase/migrations on init; `supabase migration up` catches up an old one).";

if (!STACK) {
  if (STACK_REQUIRED) {
    // Thrown at import time, exactly like the AAI_REQUIRE_PG case above: it
    // fails the FILE, which is the one outcome a green-but-skipped suite cannot
    // be confused with.
    throw new Error(
      "AAI_REQUIRE_STACK is set but the Supabase stack is not configured, so this suite " +
        `would skip.\n${HOW_TO_STACK}`,
    );
  }
  console.warn(
    `\n[skipped: no local Supabase stack] platform-arm suite not run.\n${HOW_TO_STACK}\n`,
  );
}

/**
 * `describe` with the local Supabase stack in reach, `describe.skip` otherwise —
 * announced above rather than folded into a green summary.
 *
 * The one spelling for this gate, in place of the hand-rolled conjunction
 * (`PG_URL && SB_URL && SB_SERVICE_KEY ? describe : describe.skip`) that
 * `realtime-rls.scenario.test.ts` carried while nothing in the repo resolved
 * those three values together.
 */
export const describeWithStack = STACK ? describe : describe.skip;

/**
 * The stack's values, for use inside a `describeWithStack` body.
 *
 * Same narrowing contract as `pgUrl()`: correct exactly where the guard has run,
 * and throwing rather than handing a Realtime client an `undefined` key
 * everywhere else. Note vitest EXECUTES a `describe.skip` callback to enumerate
 * what it is skipping, so read this inside a hook or a test — never at the top
 * of a gated `describe` body, where it fails the file instead of skipping it.
 */
export function stackEnv(): { url: string; serviceKey: string; anonKey?: string } {
  if (!STACK) {
    throw new Error("stackEnv() read with no Supabase stack — call it inside describeWithStack.");
  }
  return STACK;
}
