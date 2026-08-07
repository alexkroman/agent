// Self-hosted entrypoint — this is what `npm start` runs.
//
// It serves the agent over HTTP + WebSocket from your own Node process: no
// platform account, no CLI at run time, no bundler. `aai dev` is the
// development counterpart (file watching, Vite, a browser that opens itself);
// this file is the deployment.
//
//   npm start                          # http://127.0.0.1:3000
//   PORT=8080 HOST=0.0.0.0 npm start   # bind every interface, e.g. in a container
//
// Anything that can run Node can host it: copy the project, install
// dependencies, provide the secrets, run this file. Deleting it costs nothing
// — `aai dev`, `aai publish` and the managed platform never read it.

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createAgentServer, withHostCredentialFallback } from "@alexkroman1/aai/runtime";
import { defaultClientDir } from "@alexkroman1/aai-ui/client-dir";

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * Teach Node the two non-JavaScript import shapes the `aai` bundler supports,
 * so one `agent.ts` runs unchanged under `aai dev`, `aai publish`, and here.
 *
 * - `import prompt from "./system-prompt.md?raw"` — a Vite convention; Node
 *   would look for a file literally named `system-prompt.md?raw`.
 * - `import data from "./data.json"` with no import attribute — TypeScript's
 *   `resolveJsonModule` allows it; Node requires `with { type: "json" }` and
 *   otherwise fails with ERR_IMPORT_ATTRIBUTE_MISSING. An import that DOES
 *   carry the attribute is left to Node, whose own handling is correct.
 *
 * Nothing is transformed beyond that: `.ts` itself needs no help, because Node
 * strips the types natively (this project needs Node 24+). That is why there
 * is no build step here, and no second copy of the agent in JavaScript that
 * could drift from the one you deploy.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith("?raw")) {
      // Resolved by hand rather than through nextResolve: the default
      // resolver has no format for `.md` and the query would be lost anyway.
      return {
        url: new URL(specifier, context.parentURL).href,
        format: "module",
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const asRaw = url.endsWith("?raw");
    const asBareJson = url.endsWith(".json") && context.importAttributes?.type !== "json";
    if (!(asRaw || asBareJson)) return nextLoad(url, context);
    const text = readFileSync(fileURLToPath(asRaw ? url.slice(0, -"?raw".length) : url), "utf-8");
    return {
      format: "module",
      // `export default <literal>` for both: a JSON document is already a
      // valid JS expression, and JSON.stringify makes any file safe to embed
      // as a string. Emitting `format: "json"` instead would put the import
      // back under the attribute check this exists to satisfy.
      source: `export default ${asRaw ? JSON.stringify(text) : text};`,
      shortCircuit: true,
    };
  },
});

// Imported dynamically, and this is load-bearing: static `import` statements
// are hoisted and evaluated BEFORE any statement in this file, so an
// `import agent from "./agent.ts"` at the top would load the agent — and every
// `?raw` import inside it — before the hooks above were ever registered.
const { default: agent } = await import("./agent.ts");

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
 * built (`npm run build` leaves it in `.aai/client`), otherwise the prebuilt
 * default client that ships inside @alexkroman1/aai-ui.
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

const server = createAgentServer({
  agent,
  env,
  // Provider credentials may ALSO arrive straight from the environment without
  // being declared, and without becoming ctx.env — the ordinary way to hand
  // ASSEMBLYAI_API_KEY to a container. Anything in `env` still wins.
  providerEnv: withHostCredentialFallback(env),
  clientDir: resolveClientDir(),
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
