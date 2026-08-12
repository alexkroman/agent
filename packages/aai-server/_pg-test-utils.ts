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
 *   bug `jsonb-encoding.integration.test.ts` exists for — a jsonb value written
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
 * Prefer `describeWithPg` + `pgUrl()`: this is exported for the one suite whose
 * gate is a CONJUNCTION (`realtime-rls` needs the Supabase stack as well).
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
