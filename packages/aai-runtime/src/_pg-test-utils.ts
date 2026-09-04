// Copyright 2026 the AAI authors. MIT license.
/**
 * The gate on THIS package's suites that need a real Postgres.
 *
 * **It is a second copy, and the dependency flow is why.** `aai-server` owns the
 * canonical version — read `packages/aai-server/src/_pg-test-utils.ts` for the whole
 * argument, which is not restated here: why a silent skip is the worst outcome
 * available, why `AAI_REQUIRE_PG` turns one into a hard failure, and why the
 * enforcement lives inside the FUNCTION rather than in the module body. That
 * package depends on this one, so importing its test surface from here would
 * invert the spine `konsistent.json` enforces (`aai-runtime` imports only `aai`).
 * A shared helper would have to live in `aai`, which may import no sibling and
 * would then be shipping a test gate for a database it never opens.
 *
 * So this is deliberately the NARROW half: the two names a suite here needs, on
 * the same contract, with none of the stack gate. `describeWithStack` is not
 * duplicated because nothing in this package asserts a Supabase contract —
 * Vault, pg_cron, walrus and Storage are all the platform's, and the platform is
 * `aai-server`. Should a suite here ever need one, move the gate rather than
 * growing this file into a third copy.
 *
 * The env variables are the SAME ones, declared once in the `check:scenario`
 * task's `env` in `turbo.json` — that declaration is per TASK, not per package,
 * so this package's scenario tier already receives both and needed no wiring.
 *
 * ```sh
 * pnpm test:pg                    # resolve a local database, then run the tier
 * AAI_TEST_PG_URL=… pnpm --filter @alexkroman1/aai-runtime test:scenario
 * ```
 */

import { describe } from "vitest";

/**
 * `describe.skip` as a VALUE.
 *
 * Biome's `noSkippedTests` flags the `describe.skip(…)` call form, and skipping
 * is this file's whole product — so the gate references it as a value rather
 * than reaching for a suppression, exactly as its counterpart does.
 */
const skipSuite = describe.skip;

/** The test database, or `undefined` when none is configured. */
export const PG_URL: string | undefined = process.env.AAI_TEST_PG_URL;

/** Set by CI's Postgres leg: a skip here means the wiring broke. */
const REQUIRED = (process.env.AAI_REQUIRE_PG ?? "") !== "";

const HOW_TO =
  "Set AAI_TEST_PG_URL, or run `pnpm test:pg` (it finds a local Postgres — the\n" +
  "Supabase stack on 54322, or a server on 5432 — and prints how to start one\n" +
  "if there is none).";

/** One announcement per file, however many suites that file declares. */
let announced = false;

/**
 * `describe` when a database is configured, `describe.skip` otherwise — with the
 * skip ANNOUNCED rather than folded into a green summary.
 *
 * Under `AAI_REQUIRE_PG` a skip throws instead, from the CALL — which is the top
 * level of the calling suite's own module, so it fails that file and leaves every
 * other importer of this package alone.
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
  if (!announced) {
    announced = true;
    console.warn(`\n[skipped: no AAI_TEST_PG_URL] real-Postgres suite not run.\n${HOW_TO}\n`);
  }
  skipSuite(name, body);
}

/**
 * The database URL as a plain `string`, for use inside a `describeWithPg` body.
 *
 * Note vitest EXECUTES a `describe.skip` callback to enumerate what it is
 * skipping, so read this inside a hook or a test — never at the top of a gated
 * `describe` body, where it fails the file instead of skipping it.
 */
export function pgUrl(): string {
  if (!PG_URL) {
    throw new Error("pgUrl() read with no AAI_TEST_PG_URL — call it inside describeWithPg.");
  }
  return PG_URL;
}
