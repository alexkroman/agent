#!/usr/bin/env node

/**
 * Run the platform server for local development, with the local Supabase stack
 * resolved into its environment.
 *
 * `pnpm dev:aai-server` goes through here. Three things it supplies, and every
 * one of them used to be the developer's to remember:
 *
 * - **`AAI_LOCAL_DEV=1`**, the explicit declaration that this is a local run.
 *   That is what permits the isolation-free `subprocess` sandbox backend and
 *   makes the AssemblyAI key verifier optional (`sandbox-backend.ts`,
 *   `api-key-verify.ts`). It is deliberately not inferred from anything: absent,
 *   both decisions fall to their production branch, so a deploy that forgets a
 *   variable gets the safe answer rather than a hole.
 * - **The platform Supabase env** (`SUPABASE_DB_URL` and the three settings that
 *   travel with it), which is what decides whether platform state is DURABLE.
 *   Without it the server runs on memory stores, and a restart erases every
 *   deployed agent — the agents row, the deploy blobs, the studio workspace, all
 *   of it — so a session cannot resume onto an agent that no longer exists and
 *   `/use-my-agent/` answers 404 for the rest of the day. That is the bug this
 *   script exists to stop being a thing anyone has to know about.
 * - **`AAI_PUBLIC_ORIGIN`**, the newest member of that platform tier and the one
 *   whose absence stopped this command booting at all. See {@link publicOrigin}.
 *
 * ## Three layers, and the outer ones always win
 *
 * 1. **The shell environment.** Never probed, never overwritten.
 * 2. **`.env` at the repo root**, for the values a developer should not have to
 *    retype: provider keys, a scratch project's Supabase settings, whatever a
 *    branch needs. Loaded with `process.loadEnvFile`, which is Node's own
 *    `--env-file` parser and already honours layer 1 — a variable set in the
 *    shell beats the file, so a one-off override is still `FOO=bar pnpm …`.
 * 3. **The resolved local stack**, for anything the first two left unset.
 *
 * So pointing a dev server at a scratch Supabase project — or at nothing, to
 * exercise the memory tier deliberately — is one line in `.env`, and this script
 * gets out of the way for it. The resolution is checked per VARIABLE rather than
 * for the set, so half-configuring is not a state anyone can land in by accident.
 *
 * It RESOLVES a stack and never starts one: `supabase start` costs minutes and
 * gigabytes. A stack that is down is reported and the run CONTINUES on memory
 * stores, because that tier is a legitimate way to work — what it may not be is
 * silent, which is how the restart-erases-everything failure kept getting
 * rediscovered.
 *
 * ```sh
 * pnpm dev:aai-server                        # the whole thing, resolved
 * node scripts/dev-server.mjs --print        # what it would resolve, and why
 * SUPABASE_DB_URL=… pnpm dev:aai-server     # your own database, unprobed
 * ```
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseLeadingFlags } from "./_args.mjs";
import { runChild } from "./_run-child.mjs";
import { readSupabaseStack } from "./_supabase-stack.mjs";

const { values: FLAGS, rest: command } = parseLeadingFlags({
  script: import.meta.url,
  options: { print: { type: "boolean" } },
});
const PRINT_ONLY = FLAGS.print === true;

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/**
 * Load the repo-root `.env` into `process.env`, reporting whether there was one.
 *
 * `process.loadEnvFile` is Node's own `--env-file` parser, and using it rather
 * than a hand-rolled one is the point: a shell variable already beats the file
 * (verified — that is documented `--env-file` precedence), quoting and
 * multi-line values behave the way every other tool's `.env` does, and there is
 * no second dialect to explain. It also has to run BEFORE the stack resolution
 * below, because that checks `process.env` per variable — so a `SUPABASE_DB_URL`
 * in the file suppresses the probe exactly as an exported one does.
 *
 * A missing file is the ordinary case and says nothing; a file that fails to
 * PARSE is reported and skipped rather than fatal, because the server is
 * perfectly able to start without it and a broken line should not cost a whole
 * dev loop.
 */
function loadEnvFile() {
  const file = path.join(REPO_ROOT, ".env");
  if (!existsSync(file)) return;
  try {
    process.loadEnvFile(file);
    return { note: "loaded .env (shell variables still win)" };
  } catch (err) {
    return { why: `could not read .env: ${err.message}` };
  }
}

/**
 * `supabase status -o env` key → the platform variable that reads it.
 *
 * `SUPABASE_STORAGE_BUCKET` is absent because the stack does not report it: a
 * bucket is declared in `supabase/config.toml` and applied at `supabase start`,
 * so it is read from there (see {@link storageBucket}).
 */
const PLATFORM_ENV = {
  SUPABASE_DB_URL: "DB_URL",
  SUPABASE_URL: "API_URL",
  // Service-role authority, for Supabase Storage (deploy blobs) and the Realtime
  // change streams. The legacy `service_role` JWT rather than the newer
  // `SECRET_KEY`, because that is the form `assertServiceRoleKey` is verified
  // against on this stack; either passes.
  SUPABASE_SERVICE_ROLE_KEY: "SERVICE_ROLE_KEY",
  // Browser sign-in only, and it stays PUBLISHABLE — a separate setting from the
  // one above, which is the distinction `assertServiceRoleKey` refuses to let
  // anyone collapse.
  SUPABASE_PUBLISHABLE_KEY: "PUBLISHABLE_KEY",
};

/**
 * The one setting a local stack needs that `supabase status -o env` does not
 * report — DERIVED from `supabase/config.toml` and the stack's own DB_URL, so
 * local dev exercises the SAME code path production does.
 *
 * (`AAI_DBLINK_HOST` used to be the other one. It went with the pg_cron
 * orphan-preview sweep; the reap runs in the server now — see
 * `aai-server/orphan-previews.ts`.)
 *
 * Skipped when the pooler stanza is disabled, so a developer who turns it off
 * gets the direct path and the boot warning that names it, rather than a URL
 * nothing is listening on.
 */
function localStackExtras(dbUrl) {
  const file = path.join(REPO_ROOT, "supabase", "config.toml");
  const config = existsSync(file) ? readFileSync(file, "utf-8") : "";
  const env = {};
  const pooler = /^\[db\.pooler\]([\s\S]*?)(?=^\[|Z)/m.exec(config)?.[1] ?? "";
  const enabled = /^enabled\s*=\s*true/m.test(pooler);
  const port = /^port\s*=\s*(\d+)/m.exec(pooler)?.[1];
  if (enabled && port && dbUrl) {
    const url = new URL(dbUrl);
    // Supavisor identifies the tenant by a username SUFFIX and refuses a bare
    // role with `(ENOIDENTIFIER) no tenant identifier provided`; the CLI stack's
    // tenant is `pooler-dev`.
    url.username = encodeURIComponent(`${decodeURIComponent(url.username)}.pooler-dev`);
    url.port = port;
    // `pgbouncer=true` DECLARES the mode, which is the only thing that works here:
    // `isTransactionModePooler` also accepts port 6543, but that is Supavisor's
    // port INSIDE the compose network — the CLI publishes it on
    // `[db.pooler].port` (54329), so the port says nothing about the mode once it
    // has been remapped. The same is true of any pooler behind a port forward.
    url.searchParams.set("pgbouncer", "true");
    env.PLATFORM_POOLER_URL = url.toString();
  }
  return env;
}

/**
 * The deploy-artifact bucket, out of `supabase/config.toml`.
 *
 * DERIVED rather than a `"blobs"` literal here, because the stanza in that file
 * is what the local stack really applies — a literal would be a second source of
 * truth for a name that only ever surfaces as a boot failure
 * (`assertBucketPrivate`). No stanza means no bucket variable, which leaves the
 * decision to the layers above; a config file that exists and cannot be READ is
 * left to throw, since that is a broken checkout rather than a missing setting.
 */
function storageBucket() {
  const file = path.join(REPO_ROOT, "supabase", "config.toml");
  if (!existsSync(file)) return;
  const config = readFileSync(file, "utf-8");
  return /^\[storage\.buckets\.([A-Za-z0-9_-]+)\]/m.exec(config)?.[1];
}

/**
 * This server's own public origin — the third thing a PLATFORM tier refuses to
 * boot without, and the one this script did not supply.
 *
 * `AAI_PUBLIC_ORIGIN` joined `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in
 * `PLATFORM_TIER_ENV` when it stopped being optional: it is the only source of
 * `agentPublicBaseUrl` → `AAI_PUBLIC_BASE_URL`, which is half of what
 * `resolvePlatformQueue` needs to install the platform workflow world. Refusing
 * boot over it is right, and it left `pnpm dev:aai-server` DEAD against a local
 * stack — `Fatal: Missing required environment variables: AAI_PUBLIC_ORIGIN`
 * before the listener — because the script whose whole job is supplying the
 * platform env was never taught the new member.
 *
 * DERIVED rather than a literal, for the reason {@link storageBucket} is: the
 * port is `aai-server`'s to name, and a second copy of `8080` here would be a
 * setting that silently disagrees the day that one moves. `PORT` still wins,
 * since it is what the server itself reads.
 *
 * Loopback deliberately. `public-origin.ts` treats a loopback origin as the
 * local case, and an origin learned any other way is the caller's to write —
 * which is exactly the reason the variable is mandatory rather than sniffed.
 */
function publicOrigin() {
  const file = path.join(REPO_ROOT, "packages/aai-server/src/constants.ts");
  const source = existsSync(file) ? readFileSync(file, "utf-8") : "";
  const declared = /^export const DEFAULT_PORT = (\d+);/m.exec(source)?.[1];
  const port = process.env.PORT ?? declared;
  // No port and no declaration is a broken checkout rather than a missing
  // setting, so nothing is invented: the server's own boot error is a better
  // diagnostic than a guessed origin that half-works.
  return port ? { AAI_PUBLIC_ORIGIN: `http://localhost:${port}` } : {};
}

/**
 * What this run should add to `process.env`, plus one line saying why.
 *
 * The environment winning is checked per VARIABLE rather than for the set: a
 * developer who exported only `SUPABASE_DB_URL` still wants the rest resolved,
 * and half-configuring the platform tier is the one state
 * `buildPlatformDb` refuses at boot.
 */
function resolvePlatformEnv() {
  const wanted = Object.keys(PLATFORM_ENV).filter((name) => !process.env[name]);
  const bucket = storageBucket();
  if (bucket && !process.env.SUPABASE_STORAGE_BUCKET) wanted.push("SUPABASE_STORAGE_BUCKET");
  if (wanted.length === 0) {
    return { env: {}, note: "platform Supabase env already set — using it as-is" };
  }
  const stack = readSupabaseStack();
  if (!stack.values) {
    return { env: {}, why: stack.why };
  }
  const env = {};
  for (const name of wanted) {
    const value =
      name === "SUPABASE_STORAGE_BUCKET" ? bucket : stack.values.get(PLATFORM_ENV[name]);
    if (value) env[name] = value;
  }
  const missing = wanted.filter((name) => !env[name]);
  if (missing.length > 0) {
    return { env: {}, why: `\`supabase status -o env\` named no ${missing.join(", ")}` };
  }
  // Layered under the shell like everything else above: an exported value wins.
  for (const [name, value] of Object.entries(
    localStackExtras(env.SUPABASE_DB_URL ?? process.env.SUPABASE_DB_URL),
  )) {
    if (!process.env[name]) env[name] = value;
  }
  return { env, note: `local Supabase stack resolved (${stack.source})` };
}

const MEMORY_TIER = `dev-server: continuing on IN-MEMORY platform stores.

Every deployed agent, deploy blob and studio workspace lives in this process's
heap, so restarting the server ERASES them: a published agent's URL 404s and a
browser session cannot resume onto it. That is a legitimate way to work — it
just is not durable, and it is not a bug when it happens.

  supabase start        # from the repo root, for the durable tier`;

// Before the resolution, never after: the layering is the whole contract.
const envFile = loadEnvFile();
if (envFile?.note) console.log(`dev-server: ${envFile.note}`);
if (envFile?.why) console.warn(`dev-server: ${envFile.why}`);

const platform = resolvePlatformEnv();
if (platform.note) {
  console.log(`dev-server: ${platform.note}`);
} else {
  console.log(`dev-server: no local Supabase stack (${platform.why}).\n\n${MEMORY_TIER}\n`);
}

// Explicit, and the whole point of it being explicit: this is what lets a guest
// run as a child process of this server with no isolation at all, and lets a
// bearer through without asking AssemblyAI whether it is a key. Neither may ever
// follow from a variable somebody forgot to set.
const localDev = { AAI_LOCAL_DEV: process.env.AAI_LOCAL_DEV ?? "1" };

// Layered under the shell and `.env` like every resolved value above, so a
// developer pointing a dev server at a tunnel writes one line and this gets out
// of the way.
const origin = process.env.AAI_PUBLIC_ORIGIN ? {} : publicOrigin();

if (PRINT_ONLY) {
  // The EFFECTIVE values, not this script's additions: with three layers, "what
  // will the server see" is the only question worth answering here, and a
  // `.env`-supplied database would be invisible in a diff of the additions.
  const effective = { ...process.env, ...localDev, ...origin, ...platform.env };
  // `PLATFORM_POOLER_URL` is NOT in `PLATFORM_ENV` — it is derived from
  // `config.toml` rather than read out of `supabase status` — so a fixed loop
  // over that map's keys omitted the one variable that decides whether the admin
  // pool MULTIPLEXES. It was being set correctly and reported nowhere, which is
  // the same failure shape as a gate that checks nothing: the mode this script
  // exists to answer questions in gave the wrong answer to "are we pooling?".
  const names = [
    "AAI_LOCAL_DEV",
    "AAI_PUBLIC_ORIGIN",
    ...Object.keys(PLATFORM_ENV),
    "PLATFORM_POOLER_URL",
    "APP_DB_POOLER_URL",
    "SUPABASE_STORAGE_BUCKET",
  ];
  for (const name of names) {
    const value = effective[name];
    // A URL and a bucket name are safe to print; the two keys are not.
    if (value) console.log(`${name}=${name.endsWith("_KEY") ? "<set>" : value}`);
    // An ABSENT pooler URL is the interesting state, and the only one with a
    // consequence worth naming here: unset means DIRECT connections, which the
    // connection budget does not account for (the server warns at boot too).
    else if (name.endsWith("_POOLER_URL")) console.log(`${name}=<unset — DIRECT connections>`);
  }
  // NOT started here — it holds a connection and an endpoint that runs DDL, and
  // `--print` answers a question rather than running anything. Named instead,
  // because "where does SUPABASE_ACCESS_TOKEN come from" is exactly the kind of
  // thing this mode exists to answer.
  console.log(
    effective.SUPABASE_ACCESS_TOKEN
      ? "SUPABASE_ACCESS_TOKEN=<set>  # your own; the stand-in stays out of the way"
      : "SUPABASE_MANAGEMENT_URL=<a local stand-in, started on an ephemeral port>",
  );
  process.exit(0);
}

if (command.length === 0) {
  console.error("dev-server: no command given (e.g. `node --conditions=@dev/source index.ts`).");
  process.exit(1);
}

// Ctrl-C is how a dev server is MEANT to end, so it exits 0 — and the wrapper
// stays alive until the child has drained rather than dying with it. See
// `_run-child.mjs` for what each of those costs when it is missing.
runChild(command, {
  env: { ...localDev, ...origin, ...platform.env },
  label: "dev-server",
  interruptExitCode: 0,
});
