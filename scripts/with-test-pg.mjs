#!/usr/bin/env node

/**
 * Run a command with `AAI_TEST_PG_URL` — and, when the local Supabase stack is
 * up, the whole stack — resolved for it.
 *
 * The real-Postgres suites are the only tier that can see a driver-level bug —
 * an encoding that round-trips wrong, a lock that is not held by the session
 * that thinks it holds it — and they skip themselves when no database is
 * configured (see `packages/aai-server/src/_pg-test-utils.ts`). The friction was
 * that "configure a database" meant knowing the variable exists, knowing which
 * port your stack listens on, and pasting a URL each time. So the tier's own
 * bugs got found by hand, one branch at a time, and #1058 found four of them
 * that way after the unit suites were long green.
 *
 * `pnpm test:pg` is that step, once:
 *
 * ```sh
 * pnpm test:pg                        # the whole scenario tier
 * pnpm test:pg pnpm --filter aai-server test:scenario
 * node scripts/with-test-pg.mjs --print
 * node scripts/with-test-pg.mjs --require-stack pnpm test:scenario
 * ```
 *
 * `--require-stack` is CI's flag: it makes "no stack" exit 1 instead of a
 * printed note. See its declaration below for the green-job-with-no-arm this
 * closes.
 *
 * It RESOLVES a database; it deliberately does not start one. The candidates
 * are localhost-only and the suites WRITE, so a `DATABASE_URL` from the
 * environment is never picked up — that variable points at a real database on
 * plenty of machines. When nothing answers, the failure prints the commands
 * that start each of the stacks a developer here is likely to have, rather than
 * choosing one of them: starting one costs minutes and gigabytes and discards
 * whatever was in it, which is a decision the person running the tests owns.
 *
 * **A PORT IS NOT AN ARM, and finding one was all this used to do.** Probing
 * 54322 and exporting the database URL alone left
 * `realtime-rls.scenario.test.ts` — the only test of walrus anywhere — SKIPPED
 * on the one machine in the world running walrus, because its gate is a
 * conjunction over `AAI_TEST_SUPABASE_URL` / `_SERVICE_KEY` and its own header
 * documented those as something a human pastes out of `supabase status -o env`.
 * So when the 54322 probe answers, this shells out to exactly that command and
 * exports the trio beside the URL. Same "find one, never start one" contract,
 * one command wider.
 *
 * What each arm can COVER is printed, because the failure this whole tier keeps
 * finding is a run that looks identical whether or not it checked anything:
 *
 * - the **stack** covers everything — Vault, pgmq, pg_cron, pg_net, plus
 *   walrus/Realtime, Storage and Auth, on the production Postgres image.
 * - a **plain server on 5432** covers the SDK's own stores, where a plain
 *   Postgres is what a user brings (`session-state.scenario.test.ts`). It
 *   covers NO platform contract: nothing anywhere runs `aai_platform` without
 *   Vault, pg_cron and walrus, so it is a deployment nobody has. Those suites
 *   announce their own absence through `describeWithStack`.
 */

import net from "node:net";

import { parseLeadingFlags } from "./_args.mjs";
import { runChild } from "./_run-child.mjs";
import { readSupabaseStack } from "./_supabase-stack.mjs";

const { values: FLAGS, rest: command } = parseLeadingFlags({
  script: import.meta.url,
  options: { print: { type: "boolean" }, "require-stack": { type: "boolean" } },
});
const PRINT_ONLY = FLAGS.print === true;
/**
 * `--require-stack`: a stack that was EXPECTED and not resolved is exit 1.
 *
 * Without it every failure path here — no CLI, a stack that is down, a
 * `supabase status -o env` whose output this cannot parse — printed two lines
 * and let the run continue with `AAI_REQUIRE_STACK` unset. `_pg-test-utils.ts`
 * then turns `describeWithStack` into `describe.skip`, so the CI job that
 * exists for the platform arm goes GREEN with
 * `realtime-rls.scenario.test.ts` — the only walrus/RLS leak test in the
 * repository — never having run.
 *
 * `check.yml`'s platform-stack job claimed the opposite in its own comment
 * ("so a variable that stops arriving is a red job rather than a green one
 * with the only arm for the platform stores silently absent") while this
 * script was its only enforcement. It is a FLAG rather than the default
 * because a developer running `pnpm test:pg` against a plain 5432 is entitled
 * to the narrow arm with a printed reason; a job whose whole purpose is the
 * stack is not.
 */
const REQUIRE_STACK = FLAGS["require-stack"] === true;

/** The default superuser every candidate below is reached as. */
const ROLE = "postgres";

/**
 * Localhost candidates, in the order a developer here is likely to have one.
 * 54322 is the Supabase local stack's Postgres (this repo has a `supabase/`
 * directory, so it is the most likely to already be running); 5432 is a plain
 * local server, and the port CI's runner cluster listens on.
 *
 * Composed rather than written out: a literal `postgres://user:pass@host` reads
 * as a credential to biome's `noSecrets`, and the alternative to composing it
 * is a suppression comment — which would raise the escape-hatch baseline for a
 * string that is not a secret at all.
 */
const STACK_PORT = 54_322;

const CANDIDATES = [STACK_PORT, 5432].map((port) => ({
  port,
  url: `postgres://${ROLE}:${ROLE}@127.0.0.1:${port}/${ROLE}`,
  what: port === STACK_PORT ? "Supabase local stack" : "local Postgres server",
}));

/**
 * The stack's own values, out of `supabase status -o env`.
 *
 * Derived rather than guessed: the keys are stable, but the anon and
 * service-role JWTs are the CLI's to mint, and a hand-copied pair is a thing
 * that rots silently — the suite skips and the run stays green, which is the
 * failure this whole file exists to make impossible. The parse itself is
 * `scripts/_supabase-stack.mjs`, shared with `scripts/dev-server.mjs`; what is
 * local to here is which keys the scenario tier reads.
 *
 * Every way this can fail (no CLI, a stack that is down, output this cannot
 * parse) resolves to `undefined` with a printed reason. It must NOT abort the
 * run: the database half is already resolved by then, and the SDK-tier suites
 * that need only a database are entitled to it.
 */
function resolveStack() {
  const explicit = process.env.AAI_TEST_SUPABASE_URL;
  if (explicit && process.env.AAI_TEST_SUPABASE_SERVICE_KEY) {
    return { source: "AAI_TEST_SUPABASE_* from the environment", env: {} };
  }
  const stack = readSupabaseStack();
  if (!stack.values) return { why: stack.why };
  const url = stack.values.get("API_URL");
  const serviceKey = stack.values.get("SERVICE_ROLE_KEY");
  if (!(url && serviceKey)) {
    return { why: "`supabase status -o env` named no API_URL/SERVICE_ROLE_KEY" };
  }
  // Only the three the suites read are forwarded — the output also carries S3
  // credentials and a JWT secret, and a resolver that exported everything would
  // be putting them in the environment of every test process for no reason.
  const env = { AAI_TEST_SUPABASE_URL: url, AAI_TEST_SUPABASE_SERVICE_KEY: serviceKey };
  // Only gates the negative control (does a filtered subscribe deliver to
  // ANYONE else?), so its absence narrows the suite rather than skipping it.
  const anonKey = stack.values.get("ANON_KEY");
  if (anonKey) env.AAI_TEST_SUPABASE_ANON_KEY = anonKey;
  return { source: stack.source, env };
}

/** Does something accept TCP on this host:port? */
const listens = (host, port, timeoutMs = 400) =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });

async function resolveUrl() {
  // An explicit URL always wins, and is not probed: it may be a socket path or
  // a host this check cannot reach the same way the suite will.
  if (process.env.AAI_TEST_PG_URL) {
    return { url: process.env.AAI_TEST_PG_URL, what: "AAI_TEST_PG_URL" };
  }
  for (const candidate of CANDIDATES) {
    const { hostname, port } = new URL(candidate.url);
    if (await listens(hostname, Number(port))) return candidate;
  }
}

const NO_DATABASE = `with-test-pg: no local Postgres found on ${CANDIDATES.map((c) => c.port).join(" or ")}.

Start one of these, then re-run:

  supabase start                        # this repo's own stack (port 54322)
  docker run --rm -d -p 5432:5432 \\
    -e POSTGRES_PASSWORD=postgres postgres:16
  brew services start postgresql@16     # macOS, with a postgres/postgres role

Or point at one yourself:

  AAI_TEST_PG_URL=postgres://user:pass@host:5432/db pnpm test:scenario

The suites WRITE (under prefixes they own, and they clean up), so give them a
scratch database — never a real one.`;

const resolved = await resolveUrl();
if (!resolved) {
  console.error(NO_DATABASE);
  process.exit(1);
}

console.log(`with-test-pg: using ${resolved.what} — ${resolved.url}`);

// The stack is worth asking about whenever the resolved database IS the stack's
// port, explicit URL included: a developer who pasted the stack's own URL should
// not silently get the narrow arm.
const onStackPort = (() => {
  try {
    return new URL(resolved.url).port === String(STACK_PORT);
  } catch {
    return false;
  }
})();
const stack = onStackPort ? resolveStack() : undefined;

// **Name the arm, and name what it can COVER.** A tier whose fidelity differs
// between a laptop and CI, silently, is the shape of every defect this resolver
// has been fixed for.
if (stack?.env) {
  console.log(`with-test-pg: Supabase stack resolved (${stack.source}) — covers every contract`);
} else if (onStackPort) {
  console.log(
    `with-test-pg: stack NOT resolved (${stack?.why ?? "unknown"}).\n` +
      "  The platform-store suites will announce themselves as skipped; run\n" +
      "  `supabase status -o env` from the repo root to see what it reports.",
  );
} else {
  console.log(
    "with-test-pg: a plain Postgres covers the SDK's own stores (a user's own\n" +
      "  DATABASE_URL) and NO platform contract — those need Vault, pg_cron and\n" +
      "  walrus, i.e. `supabase start`. They will announce themselves as skipped.",
  );
}

// `--require-stack` turns "no stack" into a failure, and it has to be checked
// on BOTH arms: `onStackPort` false means the resolver never even looked, which
// is the likelier shape when a job's `supabase start` half-succeeded.
if (REQUIRE_STACK && !stack?.env) {
  const why = onStackPort
    ? (stack?.why ?? "unknown")
    : `nothing answered on ${STACK_PORT}, so the stack was never asked for`;
  console.error(
    `\nwith-test-pg: --require-stack was given and no Supabase stack resolved (${why}).\n\n` +
      "Exiting 1 rather than running the tier without it. With AAI_REQUIRE_STACK\n" +
      "unset, `describeWithStack` becomes `describe.skip` and the run is GREEN\n" +
      "with the platform arm — walrus/Realtime, Storage, Auth, and the only\n" +
      "RLS leak test in the repository — never executed. That is the exact\n" +
      "check-that-exists-without-running failure this whole resolver is for.\n\n" +
      "  supabase start                     # from the repo root\n" +
      "  supabase status -o env             # what this script reads\n\n" +
      "Drop the flag to accept the narrow arm deliberately.\n",
  );
  process.exit(1);
}

if (PRINT_ONLY) process.exit(0);

if (command.length === 0) {
  console.error("with-test-pg: no command given (e.g. `pnpm test:scenario`).");
  process.exit(1);
}

// A skip is what this script exists to prevent, so the run it starts refuses to
// be a quiet one: AAI_REQUIRE_PG makes the suites fail rather than skip if the
// variable somehow does not reach them (turbo's strict env mode is one way that
// happens — both names are declared in the `check:scenario` task's `env`).
// AAI_REQUIRE_STACK is the same contract one rung up, and is set ONLY when a
// stack was really resolved: it must mean "the stack is here and a skip is a
// wiring bug", never "please have a stack".
// A stop here exits NON-zero, unlike the dev server's: an interrupted test run
// verified nothing, and reporting it as a pass is how a Ctrl-C during
// `pnpm test:pg` becomes a green branch. The wrapper still waits for the child
// rather than dying with it — see `_run-child.mjs`.
runChild(command, {
  env: {
    AAI_TEST_PG_URL: resolved.url,
    AAI_REQUIRE_PG: "1",
    ...(stack?.env ? { ...stack.env, AAI_REQUIRE_STACK: "1" } : {}),
  },
  label: "with-test-pg",
  interruptExitCode: 1,
});
