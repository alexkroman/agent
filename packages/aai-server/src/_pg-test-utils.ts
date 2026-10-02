// Copyright 2026 the AAI authors. MIT license.
/**
 * The gate on the suites that need a REAL Postgres.
 *
 * Those suites assert what no in-memory fake can (advisory-lock ownership, the
 * platform migration, RLS, the driver↔Postgres encoding seam), so a silent skip
 * hides exactly the bugs they exist for. Hence:
 *
 * - `describeWithPg` / `describeWithStack` are the one spelling, and a skip
 *   prints how to get a database.
 * - `AAI_REQUIRE_PG` / `AAI_REQUIRE_STACK` turn a skip into a hard failure (CI
 *   sets them). Both must stay declared in `check:scenario`'s `env` in
 *   `turbo.json`, or strict env mode strips them and the enforcement is inert.
 * - The enforcement runs when a suite CALLS its gate, never at import: the
 *   `test-utils` barrel re-exports this module, so an import-time check would
 *   fire in every unit file that imports the package's test surface.
 *
 * ```sh
 * pnpm test:pg                    # resolve a local database, then run the tier
 * AAI_TEST_PG_URL=… pnpm --filter aai-server test:scenario
 * ```
 */

import { describe } from "vitest";

/** A gated suite's `describe`: call it at the top level of the suite's module. */
export type GatedDescribe = (name: string, body: () => void) => void;

/**
 * The one gate every real-infrastructure suite is built on: `describe` when the
 * arm is in reach, an ANNOUNCED `describe.skipIf` skip when it is not, and a
 * THROW instead of the skip when the run declared it `required`.
 *
 * The check runs when the returned function is CALLED — at the top level of the
 * suite's own module — so it fails that FILE, and no file that merely imports
 * the package's test surface is touched. The skip is announced once per gate per
 * file, however many suites the file declares.
 */
export function gatedDescribe(gate: {
  /** Why the arm is out of reach, or `undefined` when it is in reach. */
  missing: string | undefined;
  /** Whether the run declared it needs the arm (an `AAI_REQUIRE_*` variable). */
  required: boolean;
  /** The thrown message under `required`. */
  failure: string;
  /** The once-per-file warning on a skip. */
  notice: string;
}): GatedDescribe {
  let announced = false;
  return (name, body) => {
    const skip = gate.missing !== undefined;
    if (skip && gate.required) throw new Error(gate.failure);
    if (skip && !announced) {
      announced = true;
      console.warn(gate.notice);
    }
    describe.skipIf(skip)(name, body);
  };
}

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

/**
 * `describe` when a database is configured, an announced skip otherwise; under
 * `AAI_REQUIRE_PG` the skip throws instead (see {@link gatedDescribe}).
 */
export const describeWithPg: GatedDescribe = gatedDescribe({
  missing: PG_URL ? undefined : "no AAI_TEST_PG_URL",
  required: REQUIRED,
  failure: `AAI_REQUIRE_PG is set but AAI_TEST_PG_URL is not, so this suite would skip.\n${HOW_TO}`,
  notice: `\n[skipped: no AAI_TEST_PG_URL] real-Postgres suite not run.\n${HOW_TO}\n`,
});

/**
 * The database URL as a plain `string`, for use inside a `describeWithPg` body
 * — in place of an unchecked `PG_URL as string`. Called outside the guard it
 * throws naming the mistake instead of handing a connection helper `undefined`.
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
 * A plain Postgres is not an arm for anything in `aai_platform`: Vault,
 * pg_cron, pg_net, walrus/Realtime, Storage and Auth are Supabase's, so the
 * stack is the ONE real arm for those contracts and its absence must be loud.
 * The ANON key is part of the conjunction: an RLS spec needs it, and an arm that
 * cannot run its own assertions must be an announced skip, never a red test.
 * `pnpm test:pg` and `turbo.json` resolve and declare all three together.
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

/**
 * `describe` with the local Supabase stack in reach, an announced skip
 * otherwise; under `AAI_REQUIRE_STACK` the skip throws instead (see
 * {@link gatedDescribe}).
 */
export const describeWithStack: GatedDescribe = gatedDescribe({
  missing: STACK ? undefined : "no local Supabase stack",
  required: STACK_REQUIRED,
  failure:
    "AAI_REQUIRE_STACK is set but the Supabase stack is not configured, so this suite " +
    `would skip.\n${HOW_TO_STACK}`,
  notice: `\n[skipped: no local Supabase stack] platform-arm suite not run.\n${HOW_TO_STACK}\n`,
});

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

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A real ULID-SHAPED id: 10 characters of millisecond timestamp, then 16 of
 * randomness — here CHOSEN rather than random, so a case can say which of two
 * ids minted in the same millisecond was minted second. The shape is the
 * premise of a run-id tiebreak (a ULID sorts by generation time); a uuid would
 * tie-break to nonsense and the case would still pass.
 */
export function ulid(ms: number, tail: string): string {
  let time = "";
  let n = ms;
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD.charAt(n % 32) + time;
    n = Math.floor(n / 32);
  }
  return `${time}${tail.padStart(16, "0")}`;
}
