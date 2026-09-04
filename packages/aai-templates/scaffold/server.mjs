// Self-hosted entrypoint — this is what `npm start` runs.
//
// It serves the agent over HTTP + WebSocket from your own Node process: no
// platform account, no managed anything. `aai dev` is the development
// counterpart (file watching, Vite, a browser that opens itself); this file is
// the deployment.
//
//   npm start                          # http://127.0.0.1:3000
//   PORT=8080 HOST=0.0.0.0 npm start   # bind every interface, e.g. in a container
//
// Anything that can run Node can host it: copy the project, install
// dependencies, provide the secrets, run `npm start`. Deleting this file costs
// nothing — `aai dev`, `aai publish` and the managed platform never read it.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import {
  createAgentServer,
  ensureSessionStateSchema,
  ensureWorkflowJournalSchema,
  withHostCredentialFallback,
} from "@alexkroman1/aai-runtime";
import { defaultClientDir } from "@alexkroman1/aai-ui/client-dir";

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * The built agent — `.aai/worker.mjs`, produced by `aai build`, which the
 * `prestart` script runs for you. It is the SAME artifact `aai publish` uploads
 * and the managed platform runs, so a self-hosted agent and a deployed one
 * cannot behave differently.
 *
 * Loading the build rather than `agent.ts` directly is what makes `tools/`
 * work. A tool is registered by EXISTING — its file name is the name the model
 * calls, and nothing anywhere lists them — and the only place a directory can
 * be turned into modules is where the bundle is assembled: a deployed agent is
 * handed one ESM string and has no filesystem to scan. So the bundler
 * enumerates `tools/` and emits the imports, and every loader that skips it
 * would serve an agent with no tools at all.
 *
 * It also settles two things the bundler already resolves, and this file used
 * to re-implement with `node:module` hooks: `import prompt from
 * "./system-prompt.md?raw"` (a Vite convention — Node looks for a file
 * literally named `system-prompt.md?raw`) and `import data from "./data.json"`
 * with no import attribute (TypeScript's `resolveJsonModule` allows it, Node
 * requires `with { type: "json" }`). Both are inlined into the bundle, so
 * there is nothing left to teach Node.
 */
const workerPath = path.join(root, ".aai", "worker.mjs");
if (!existsSync(workerPath)) {
  console.error(
    `No built agent at ${path.relative(root, workerPath)}.\n` +
      "Run `npm run build` (or `aai build`) first — `npm start` normally does it for you.",
  );
  process.exit(1);
}
// A file: URL rather than a relative specifier, so the path is correct on
// Windows, where a bare POSIX-looking path is not a valid module specifier.
const worker = await import(pathToFileURL(workerPath).href);
const agent = worker.default;

/**
 * Parse a dotenv-syntax file into a record; `{}` when it does not exist.
 *
 * @param {string} file - Path relative to the project root.
 * @returns {Promise<Record<string, string | undefined>>}
 */
async function readEnvFile(file) {
  try {
    return parseEnv(await readFile(path.join(root, file), "utf-8"));
  } catch (err) {
    // Absent is normal — `.env` is gitignored, and a container usually has
    // neither file. Unreadable is not: the agent would boot with no
    // credentials and fail later as an opaque provider auth error.
    if (err.code !== "ENOENT") throw err;
    return {};
  }
}

/**
 * Build `ctx.env` — what this agent's own tool code reads.
 *
 * The rule is the one `aai dev` follows: only DECLARED keys are exposed, and a
 * real environment variable wins over the file's value. Nothing else from
 * process.env comes along, so the agent cannot come to depend on a variable
 * (PATH, HOME, …) that will not exist wherever you deploy it.
 *
 * `.env.example` counts as a declaration too, which is what lets a container
 * run with no `.env` at all: the committed file names the secrets the agent
 * needs, and `docker run -e MY_API_KEY=…` supplies the values. Declare
 * `DATABASE_URL` the same way to give your tools `ctx.db`.
 */
async function resolveAgentEnv() {
  const declared = { ...(await readEnvFile(".env.example")), ...(await readEnvFile(".env")) };
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, fileValue] of Object.entries(declared)) {
    const value = process.env[key] ?? fileValue;
    // An empty value is worse than a missing one: a provider would try to
    // authenticate with "" rather than report the credential as absent. The
    // example file is full of them by design (`BRAVE_API_KEY=`). A key the
    // parser saw with no value at all is the same case.
    if (value !== undefined && value !== "") env[key] = value;
  }
  return env;
}

/**
 * Static assets served at `/`: this project's own UI once `client.tsx` has been
 * built (the same `aai build` leaves it in `.aai/client`), otherwise the
 * prebuilt default client that ships inside @alexkroman1/aai-ui.
 */
function resolveClientDir() {
  const built = path.join(root, ".aai", "client");
  if (existsSync(path.join(built, "index.html"))) return built;
  if (existsSync(path.join(root, "client.tsx"))) {
    console.warn("client.tsx is not built — serving the default UI. Run `npm run build` first.");
  }
  return defaultClientDir();
}

/**
 * The error classes that mean a DEFECT in this code rather than a mistake in
 * the configuration.
 *
 * Everything below turns a boot failure into two lines and a non-zero exit,
 * which is right for "ASSEMBLYAI_API_KEY is not set" and wrong for a
 * `TypeError`, where the traceback is the only thing that can locate the bug.
 * Those are re-thrown untouched.
 */
const BUG_ERRORS = [TypeError, ReferenceError, RangeError, SyntaxError];

/**
 * Every distinct message on an error and its `cause` chain, outermost first.
 *
 * A driver failure states the useful half one hop down — `connect to database
 * failed: getaddrinfo ENOTFOUND db` — so printing only the top message is how a
 * tidy envelope ends up less informative than the stack it replaced.
 *
 * @param {unknown} err
 * @returns {string}
 */
function errorText(err) {
  /** @type {string[]} */
  const messages = [];
  /** @type {unknown} */
  let cursor = err;
  while (cursor instanceof Error) {
    if (cursor.message !== "" && !messages.includes(cursor.message)) messages.push(cursor.message);
    cursor = cursor.cause;
  }
  return messages.length > 0 ? messages.join(": ") : String(err);
}

/**
 * Run one step of BOOT, and answer a failure the way this file already answers
 * a missing build artifact: what is wrong, then what to do, then exit 1.
 *
 * Without this, a missing provider key — the commonest way a first `npm start`
 * fails — killed the process with a ten-frame traceback pointing into
 * `node_modules/@alexkroman1/aai-runtime/dist/host-env-*.js`. The MESSAGE was
 * already good ("AssemblyAI LLM: missing API key. Set ASSEMBLYAI_API_KEY in the
 * agent env."); what it arrived wrapped in was a crash report about somebody
 * else's bundle, in a container that then restarted and did it again.
 *
 * Exiting is deliberate rather than binding anyway and serving an unhealthy
 * `/health`: a process that stays up tells an orchestrator it started, and a
 * misconfigured deployment that reports itself healthy is worse than one that
 * refuses to run. The non-zero exit is what a supervisor, a `docker run`, and
 * CI all already read.
 *
 * @template T
 * @param {string} fix - What the operator should change, in one sentence.
 * @param {() => T | Promise<T>} work
 * @returns {Promise<T>}
 */
async function bootOrExit(fix, work) {
  try {
    return await work();
  } catch (err) {
    if (BUG_ERRORS.some((kind) => err instanceof kind)) throw err;
    console.error(`Cannot start the agent: ${errorText(err)}\n${fix}`);
    process.exit(1);
  }
}

const env = await resolveAgentEnv();

/**
 * Where THIS server is reachable from outside — `PUBLIC_URL`, e.g.
 * `https://agent.example.com`. Set it whenever a durable workflow has to hand a
 * URL to somebody else: `ctx.workflows.publicWebhookUrl(token)` is built from it,
 * and without it that call throws rather than minting a `http://localhost:3000`
 * URL that a payment provider will try, days later, and fail.
 *
 * Nothing else reads it, so it is not a startup requirement: an agent with no
 * webhooks needs no value here. It is deliberately NOT derived from `PORT`/`HOST`
 * — those describe the socket this process binds, which behind a reverse proxy is
 * not what the outside world dials.
 */
const publicUrl = process.env.PUBLIC_URL?.trim();

/**
 * Create the session-state tables, when this agent has a database.
 *
 * A `DATABASE_URL` puts session state in Postgres, and those tables come with
 * whoever OWNS the database — which for a self-hosted agent is you, with no
 * migration step anywhere to hang them off. Without this the server starts,
 * reports `sessionState: postgres, durable: true`, and then every session dies
 * at start with a fatal error the browser shows as "Session failed to start",
 * the real reason (`relation "aai_session_events" does not exist`) appearing
 * only in this process's log.
 *
 * Best-effort: if a real migration already created them and this role may not
 * CREATE, it warns and the server starts anyway.
 */
// Read into a const: `env.DATABASE_URL` is a record lookup, so its narrowing
// does not survive into the callback below.
const databaseUrl = env.DATABASE_URL;
if (databaseUrl) {
  await bootOrExit(
    "Check DATABASE_URL: this server has to reach that database at boot to create the tables it owns.",
    async () => {
      await ensureSessionStateSchema({ url: databaseUrl, logger: console });
      // And the durable-run journal's, which is a separate set of tables owned
      // by the same deployment. Without it a project with a `DATABASE_URL`
      // boots claiming durable runs and fails on the first one.
      await ensureWorkflowJournalSchema({ url: databaseUrl, logger: console });
    },
  );
} else {
  /**
   * Say that this process is the only place the state lives, because the next
   * thing an operator does with a container is run two of them.
   *
   * Session state (slots, the event log) is keyed by session id and held in
   * memory here — the boot line below reports it as `sessionState: { backend:
   * 'memory', durable: false }`, which is true and easy to read as being about
   * restarts alone. It is also about REPLICAS: the browser reconnects with
   * `?sessionId=<id>`, so a reconnect that lands on a different process resumes
   * a session that process has never heard of and the agent's context is gone
   * mid-call. One replica has no such problem, which is exactly why nothing
   * catches this until the deployment grows a second one.
   */
  console.warn(
    "No DATABASE_URL: session state and durable runs live in THIS process's memory.\n" +
      "One replica is fine. Behind a load balancer, enable sticky sessions so a reconnect " +
      "(the client re-dials with ?sessionId=) reaches the same process — or set DATABASE_URL " +
      "and let every replica share the state.",
  );
}

const server = await bootOrExit(
  // The commonest first-run failure, and the one whose stack this replaces: a
  // provider credential that is not there. `.env` is what `aai dev` reads too,
  // so the fix is the same one in both places.
  "Set the missing value in .env, or pass it as a real environment variable (`docker run -e NAME=value`), then start again.",
  () =>
    createAgentServer({
      agent,
      env,
      // Provider credentials may ALSO arrive straight from the environment without
      // being declared, and without becoming ctx.env — the ordinary way to hand
      // ASSEMBLYAI_API_KEY to a container. Anything in `env` still wins.
      providerEnv: withHostCredentialFallback(env),
      clientDir: resolveClientDir(),
      ...(publicUrl ? { publicUrl } : {}),
      // Durable workflows need nothing passed here. A `DATABASE_URL` in `env` puts
      // the runs in Postgres and they survive a restart; without one they live in a
      // per-process directory and do not, which is the same trade `aai dev` makes.
      //
      // Two options used to sit here — the compiled workflow surface, carried on the
      // bundle as `__aaiWorkflowCode`/`__aaiStepCode` because a `"use workflow"` body
      // had to go through a compiler at BUILD time. The engine reads the agent's own
      // `workflows` declaration instead, so there is no artifact to hand over.
    }),
);

// Loopback by default: this server has no request authentication of its own,
// so exposing it is a deliberate act. Set HOST=0.0.0.0 to bind every interface
// behind your own proxy or auth. An empty HOST means unset, not "everything".
const host = process.env.HOST?.trim() || undefined;
const port = Number(process.env.PORT ?? 3000);
await bootOrExit(
  `Nothing is listening yet — port ${port} is in use, or this process may not bind it. Set PORT to a free one.`,
  () => server.listen(port, host),
);
console.log(`${agent.name} listening on http://${host ?? "127.0.0.1"}:${server.port}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  // A SYNCHRONOUS listener. An `async` one hands its promise to `process`,
  // which discards what a listener returns — so a `close()` that rejects would
  // surface as an unhandled rejection, i.e. a crash with a stack trace on
  // Ctrl-C, instead of the non-zero exit a failed shutdown should be.
  process.once(signal, () => {
    // close() shuts the runtime down too — no separate runtime.shutdown().
    server.close().then(
      () => process.exit(0),
      (error) => {
        console.error(`shutdown failed: ${error?.message ?? error}`);
        process.exit(1);
      },
    );
  });
}
