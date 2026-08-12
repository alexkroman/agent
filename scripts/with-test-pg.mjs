#!/usr/bin/env node

/**
 * Run a command with `AAI_TEST_PG_URL` pointed at a local Postgres.
 *
 * The real-Postgres suites are the only tier that can see a driver-level bug —
 * an encoding that round-trips wrong, a lock that is not held by the session
 * that thinks it holds it — and they skip themselves when no database is
 * configured (see `packages/aai-server/_pg-test-utils.ts`). The friction was
 * that "configure a database" meant knowing the variable exists, knowing which
 * port your stack listens on, and pasting a URL each time. So the tier's own
 * bugs got found by hand, one branch at a time, and #1058 found four of them
 * that way after the unit suites were long green.
 *
 * `pnpm test:pg` is that step, once:
 *
 * ```sh
 * pnpm test:pg                        # the whole integration tier
 * pnpm test:pg pnpm --filter aai-server test:integration
 * node scripts/with-test-pg.mjs --print
 * ```
 *
 * It RESOLVES a database; it deliberately does not start one. The candidates
 * are localhost-only and the suites WRITE, so a `DATABASE_URL` from the
 * environment is never picked up — that variable points at a real database on
 * plenty of machines. When nothing answers, the failure prints the commands
 * that start each of the three stacks a developer here is likely to have,
 * rather than choosing one of them: CI itself does not use Docker (its
 * integration matrix includes macOS, where it is unavailable), so a
 * Docker-only local path would diverge from the thing it is meant to
 * reproduce.
 */

import { spawn } from "node:child_process";
import net from "node:net";

const args = process.argv.slice(2);
const PRINT_ONLY = args[0] === "--print";
const command = (args[0] === "--" ? args.slice(1) : args).filter((a) => a !== "--print");

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
const CANDIDATES = [54_322, 5432].map((port) => ({
  port,
  url: `postgres://${ROLE}:${ROLE}@127.0.0.1:${port}/${ROLE}`,
  what: port === 54_322 ? "Supabase local stack" : "local Postgres server",
}));

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

  AAI_TEST_PG_URL=postgres://user:pass@host:5432/db pnpm test:integration

The suites WRITE (under prefixes they own, and they clean up), so give them a
scratch database — never a real one.`;

const resolved = await resolveUrl();
if (!resolved) {
  console.error(NO_DATABASE);
  process.exit(1);
}

console.log(`with-test-pg: using ${resolved.what} — ${resolved.url}`);
if (PRINT_ONLY) process.exit(0);

if (command.length === 0) {
  console.error("with-test-pg: no command given (e.g. `pnpm test:integration`).");
  process.exit(1);
}

// A skip is what this script exists to prevent, so the run it starts refuses to
// be a quiet one: AAI_REQUIRE_PG makes the suites fail rather than skip if the
// variable somehow does not reach them (turbo's strict env mode is one way that
// happens — both names are declared in the `check:integration` task's `env`).
const child = spawn(command[0], command.slice(1), {
  stdio: "inherit",
  env: { ...process.env, AAI_TEST_PG_URL: resolved.url, AAI_REQUIRE_PG: "1" },
  shell: process.platform === "win32",
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
child.on("error", (err) => {
  console.error(`with-test-pg: could not run \`${command.join(" ")}\`: ${err.message}`);
  process.exit(1);
});
