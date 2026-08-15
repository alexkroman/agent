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
import { createAgentServer, withHostCredentialFallback } from "@alexkroman1/aai/runtime";
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
const { default: agent } = await import(pathToFileURL(workerPath).href);

/** Parse a dotenv-syntax file into a record; `{}` when it does not exist. */
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
  const env = {};
  for (const [key, fileValue] of Object.entries(declared)) {
    const value = process.env[key] ?? fileValue;
    // An empty value is worse than a missing one: a provider would try to
    // authenticate with "" rather than report the credential as absent. The
    // example file is full of them by design (`BRAVE_API_KEY=`).
    if (value !== "") env[key] = value;
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

const server = createAgentServer({
  agent,
  env,
  // Provider credentials may ALSO arrive straight from the environment without
  // being declared, and without becoming ctx.env — the ordinary way to hand
  // ASSEMBLYAI_API_KEY to a container. Anything in `env` still wins.
  providerEnv: withHostCredentialFallback(env),
  clientDir: resolveClientDir(),
  ...(publicUrl ? { publicUrl } : {}),
});

// Loopback by default: this server has no request authentication of its own,
// so exposing it is a deliberate act. Set HOST=0.0.0.0 to bind every interface
// behind your own proxy or auth. An empty HOST means unset, not "everything".
const host = process.env.HOST?.trim() || undefined;
await server.listen(Number(process.env.PORT ?? 3000), host);
console.log(`${agent.name} listening on http://${host ?? "127.0.0.1"}:${server.port}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    // close() shuts the runtime down too — no separate runtime.shutdown().
    await server.close();
    process.exit(0);
  });
}
