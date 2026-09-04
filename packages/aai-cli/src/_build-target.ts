// Copyright 2026 the AAI authors. MIT license.
/**
 * Deployment TARGETS — what `aai build` emits beside the worker so a host can
 * run this project without the project holding anything host-specific.
 *
 * ## Why a target rather than a file in the scaffold
 *
 * Every host wants a different entry shape: Vercel wants a module whose default
 * export is an `http.Server` it binds itself, a container wants a long-lived
 * process, another platform wants something else again. Committing one of those
 * to the scaffold makes every project assert a fact that is load-bearing on
 * exactly one host — the same objection that removed `server.mjs`.
 *
 * Nitro is the worked precedent: one codebase, a preset per provider, and the
 * preset EMITS the host's expected shape into the build directory. `node-server`
 * is its default and Vercel/Netlify/Cloudflare are detected from the CI
 * environment with no configuration. Next does the same narrower thing with
 * `output: "standalone"` — it generates a `server.js` rather than asking anyone
 * to write one. Either way the user's repository contains no host file, which is
 * the property to preserve here.
 *
 * ## Auto-detection, and why it is safe
 *
 * A target is chosen with `--target`, or detected from the environment when the
 * flag is absent. Detection reads the variables the hosts set on their own build
 * containers ({@link TARGET_ENV_MARKERS}), so it only ever fires where the build
 * is genuinely running on that host — a laptop sets none of them and gets
 * {@link DEFAULT_BUILD_TARGET}, which emits nothing extra and is what every
 * existing project already does.
 */

import path from "node:path";

/** The targets `aai build --target` accepts. */
export const BUILD_TARGETS = ["node", "vercel", "deno"] as const;

export type BuildTarget = (typeof BUILD_TARGETS)[number];

/**
 * What a build with no `--target` and no host environment produces: the worker
 * and the client, and nothing else.
 *
 * `node` rather than a `"none"` sentinel because it NAMES the deployment it
 * serves — a long-lived process running `aai start` — which is what every
 * container platform wants and what the scaffold's own `start` script runs.
 */
export const DEFAULT_BUILD_TARGET: BuildTarget = "node";

/**
 * The environment variable each host sets on its own build container.
 *
 * `VERCEL` is set for every Vercel build and deployment. Detection is per host
 * rather than a single "am I in CI" test, because a GitHub Action building a
 * container image is CI too and wants the default.
 *
 * `DENO_DEPLOY` and `DENO_DEPLOYMENT_ID` are both Deno Deploy's "you are
 * running here" variables, and BOTH are listed because neither one covers both
 * GENERATIONS of the platform. Deno Deploy Classic sets `DENO_DEPLOYMENT_ID`
 * and `DENO_REGION` and no `DENO_DEPLOY` at all; the current platform sets
 * both. So `DENO_DEPLOYMENT_ID` is the only marker present in either, and
 * reading just `DENO_DEPLOY` — as this did — left Classic undetectable. That is
 * why `std-env` (the library Nitro detects providers with) tests the pair as
 * ONE signal, and why Nitro's Deno preset reads that one for its manifest.
 *
 * These are read at BUILD time, and that is reachable rather than theoretical:
 * Deno Deploy's git integration runs the build on its OWN infrastructure with
 * them set — its reference singles out `DENO_TIMELINE` as the one variable NOT
 * set during a build — so `aai build` there resolves this target with no flag,
 * the same zero-config property `VERCEL` gives.
 *
 * What detection cannot see is the documented LOCAL flow, and the reason is
 * ORDERING rather than a missing marker: `aai build --target deno` then
 * `deno deploy` from `.aai/deno/` finishes the build on the developer's own
 * machine before the upload command runs at all, so there is no host
 * environment left to advertise itself. Nitro has the identical hole and
 * answers it the same way — its own docs pass `NITRO_PRESET=deno_deploy`
 * explicitly. The flag is the path that matters; detection covers the host that
 * builds FOR you.
 */
export const TARGET_ENV_MARKERS: Readonly<Record<string, BuildTarget>> = {
  VERCEL: "vercel",
  DENO_DEPLOY: "deno",
  DENO_DEPLOYMENT_ID: "deno",
};

export function isBuildTarget(value: string): value is BuildTarget {
  return (BUILD_TARGETS as readonly string[]).includes(value);
}

/**
 * Resolve the target for this build: an explicit flag wins, then the
 * environment, then {@link DEFAULT_BUILD_TARGET}.
 *
 * An unrecognised `--target` is REFUSED naming what is accepted, rather than
 * falling back to the default — a typo'd target that silently built the default
 * would deploy a project missing the entry its host needs, and the failure would
 * arrive as a 404 from the platform rather than as an error from the build.
 */
export function resolveBuildTarget(
  explicit: string | undefined,
  env: Record<string, string | undefined> = process.env,
): BuildTarget {
  if (explicit !== undefined) {
    if (!isBuildTarget(explicit)) {
      throw new Error(`Unknown build target "${explicit}". Accepted: ${BUILD_TARGETS.join(", ")}.`);
    }
    return explicit;
  }
  for (const [marker, target] of Object.entries(TARGET_ENV_MARKERS)) {
    if (env[marker]) return target;
  }
  return DEFAULT_BUILD_TARGET;
}

/**
 * Where a PREBUILT Vercel deployment lives, relative to the project root.
 *
 * The Build Output API rather than an `api/` entry plus a `vercel.json`, and
 * the reason is ORDERING. Vercel reads `vercel.json` and decides what to build
 * BEFORE it runs the build command, so a `vercel.json` that the build WRITES
 * configures the NEXT deployment and not this one — a clean clone deploys with
 * no rewrite and no function at all. The `api/` shape only ever appeared to
 * work because a previous local `aai build --target vercel` had left both
 * files in the working tree, which is a property of one laptop rather than of
 * the repository. `.vercel/output/` is read AFTER the build command; it is the
 * only place a build can describe its own deployment.
 *
 * Two more things fall out of owning the directory, both of which the `api/`
 * shape got wrong and could not fix. The function bundle is ASSEMBLED here
 * rather than traced, so `.aai/worker.mjs` — loaded through a dynamic
 * `import(pathToFileURL(...))` that no static tracer can follow — and
 * `.env.example` — the file that DECLARES which variables become `ctx.env` —
 * are present because they were copied in. And the built client is served by
 * the CDN out of `static/` instead of through the function.
 *
 * Nitro's vercel preset is the worked precedent and lands in exactly here:
 * `output.dir = {{rootDir}}/.vercel/output`, `serverDir` a `.func` under it.
 *
 * @see https://vercel.com/docs/build-output-api/v3
 */
export const VERCEL_OUTPUT_DIR = path.join(".vercel", "output");

/**
 * The one function every request that is not a static file reaches.
 *
 * The Build Output API derives a function's ROUTE from its path, so the
 * directory name IS a URL and must not collide with one the static output
 * claims. **`index.func` collides**, which a deployment is the only way to
 * find out: it is served at `/index`, and Vercel's directory index resolves
 * `/` to the extensionless `/index` — so the function won `/`, every other
 * asset came off the CDN correctly, and the home page 500'd on a deployment
 * whose static output was perfect. Measured on a real preview:
 * `/favicon.ico`, `/index.html` and both hashed `/assets/*` returned 200
 * while `/` and `/index` did not.
 *
 * `__server` is Nitro's answer to the same problem (`__server.func`) and the
 * reason is this one: a double-underscore prefix is not a path any bundler
 * emits, so no static file can ever take the name.
 */
export const VERCEL_FUNCTION_DIR = path.join(VERCEL_OUTPUT_DIR, "functions", "__server.func");

/**
 * The route {@link VERCEL_FUNCTION_DIR} is served at — its directory name
 * without `.func`, which is how the Build Output API names a function.
 */
export const VERCEL_FUNCTION_ROUTE = "/__server";

/** Static assets the Vercel CDN serves directly, never reaching the function. */
export const VERCEL_STATIC_DIR = path.join(VERCEL_OUTPUT_DIR, "static");

/**
 * Node versions Vercel offers. A build on anything newer picks the newest of
 * these rather than naming a runtime the platform will reject.
 *
 * @see https://vercel.com/docs/functions/runtimes/node-js/node-js-versions
 */
const SUPPORTED_NODE_MAJORS = [20, 22, 24] as const;

/** `nodejs<major>.x` for the Node running this build, clamped to what Vercel offers. */
export function vercelNodeRuntime(version: string = process.versions.node): string {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  const supported = Number.isNaN(major)
    ? 22
    : (SUPPORTED_NODE_MAJORS.findLast((v) => v <= major) ?? SUPPORTED_NODE_MAJORS[0]);
  return `nodejs${supported}.x`;
}

/**
 * The Vercel function entry, emitted into {@link VERCEL_FUNCTION_DIR}.
 *
 * ## Why a `(req, res)` handler and not `export default server`
 *
 * `export default <http.Server>` is what Vercel's own `@vercel/node` BUILDER
 * accepts, and it is the shape the previous `api/index.mjs` used. The Build
 * Output API has no builder in the path: `launcherType: "Nodejs"` invokes the
 * module's default export as a request handler, so the server never gets
 * bound and there is nothing to raise an `upgrade` event on it.
 *
 * ## How a WebSocket survives that
 *
 * Vercel hands a Node function the raw upgrade through its PER-REQUEST
 * context — `globalThis[Symbol.for("@vercel/request-context")].get()
 * .upgradeWebSocket()` returns the `{ req, socket, head }` triple — rather
 * than as an event. Nitro reaches it through `crossws/adapters/vercel`; here
 * the adapter is three lines, because {@link AgentServer.node} is a real
 * `http.Server` that already has both an `upgrade` and a `request` listener
 * registered. Re-emitting onto it is the whole translation, and it means the
 * deployed path through `server.ts` is the same one `aai dev` and `aai start`
 * take — no second WebSocket entry point to keep in step.
 *
 * The `204` afterwards is what the launcher needs to consider the invocation
 * finished; the socket the agent is now talking on is not this `res`.
 *
 * ## `import.meta.dirname`, not `process.cwd()`
 *
 * The function's working directory belongs to the platform, but `.aai/` and
 * `.env.example` were copied in BESIDE this file. Resolving from the module
 * keeps that a fact about the bundle rather than about how Vercel happens to
 * invoke it.
 */
export const VERCEL_ENTRY_SOURCE = `// Generated by \`aai build --target vercel\` — do not edit, and do not commit.
// Vercel invokes this handler per request and delivers a WebSocket upgrade
// through its request context. See @alexkroman1/aai-cli/start.
import { createProjectServer } from "@alexkroman1/aai-cli/start";

const server = (await createProjectServer({ cwd: import.meta.dirname })).node;

const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

export default function handler(req, res) {
  if (req.method === "GET" && req.headers.upgrade?.toLowerCase() === "websocket") {
    const upgrade = globalThis[REQUEST_CONTEXT]?.get?.()?.upgradeWebSocket?.();
    if (upgrade) {
      server.emit("upgrade", upgrade.req, upgrade.socket, upgrade.head);
      if (!res.headersSent && !res.writableEnded) {
        res.statusCode = 204;
        res.end();
      }
      return;
    }
  }
  server.emit("request", req, res);
}
`;

/**
 * `.vc-config.json` — how the platform runs {@link VERCEL_ENTRY_SOURCE}.
 *
 * `supportsResponseStreaming` is not optional here: an agent streams TTS audio
 * and SSE workflow events, and without it the platform buffers a response to
 * completion, which for a stream that ends when the call does means it never
 * arrives. `shouldAddHelpers` stays off — the entry speaks `node:http`, and
 * the helpers exist to bolt Express-shaped sugar onto a handler that does not.
 */
export function vercelFunctionConfigSource(runtime: string = vercelNodeRuntime()): string {
  return `${JSON.stringify(
    {
      runtime,
      handler: "index.mjs",
      launcherType: "Nodejs",
      shouldAddHelpers: false,
      supportsResponseStreaming: true,
    },
    null,
    2,
  )}\n`;
}

/**
 * `config.json` — the routing table, and the reason static assets stop paying
 * for a function invocation.
 *
 * `{ "handle": "filesystem" }` serves anything present in
 * {@link VERCEL_STATIC_DIR} from the CDN and only then falls through, so the
 * client bundle, its assets and the worklets are edge-served while
 * `/client-config`, `/websocket`, `/workflows/*` and the webhook route reach
 * the agent. The `api/` shape routed EVERY request through the function, which
 * this file's earlier revision noted as deliberate and "not what makes a
 * deployment work or not" — true of correctness, false of cost, and free here
 * because the Build Output API already separates the two directories.
 */
export const VERCEL_BUILD_CONFIG_SOURCE = `${JSON.stringify(
  {
    version: 3,
    routes: [{ handle: "filesystem" }, { src: "/(.*)", dest: VERCEL_FUNCTION_ROUTE }],
  },
  null,
  2,
)}\n`;

/**
 * Where a self-contained Deno deployment is emitted, relative to the project.
 *
 * A DIRECTORY to deploy rather than files scattered through the project, and
 * `deno deploy` from inside it uploads exactly this and nothing else. That
 * matters more here than it does on Vercel: Deploy uploads the working
 * directory, so an emit into the project root would ship `node_modules`, the
 * source, and the developer's `.env` alongside the thing meant to run.
 */
export const DENO_OUTPUT_DIR = path.join(".aai", "deno");

/** The bundled entry inside {@link DENO_OUTPUT_DIR}, and Deploy's entrypoint. */
export const DENO_ENTRY_FILE = "server.mjs";

/** Deno's own project file inside {@link DENO_OUTPUT_DIR}. */
export const DENO_CONFIG_FILE = "deno.json";

/**
 * The `deno.json` written beside the entry, so the output DESCRIBES how to run
 * itself.
 *
 * Without it every command against this directory has to re-supply the
 * entrypoint — `deno deploy --entrypoint server.mjs`, `deno run -A server.mjs`
 * — which is a fact about the emit that the emit already knows and the user has
 * to remember. Nitro's `deno-server` preset writes the same file for the same
 * reason (its `compiled` hook, a `tasks.start`), and its own test suite then
 * runs a bare `deno task start`.
 *
 * `-A` rather than a narrowed permission set, and that is deliberate: the
 * server binds a port, reads the client directory and the worker off disk, and
 * reads the environment, so an enumerated list here would be a second
 * declaration of the runtime's needs that drifts the first time one changes.
 * Deno Deploy grants its own permissions regardless; this file is what makes
 * the directory runnable BY HAND, which is how a failed deployment gets
 * diagnosed.
 */
export const DENO_CONFIG_SOURCE = `${JSON.stringify(
  { tasks: { start: `deno run -A ./${DENO_ENTRY_FILE}` } },
  null,
  2,
)}\n`;

/**
 * The Deno entry, bundled into {@link DENO_ENTRY_FILE}.
 *
 * ## Why this BINDS, where the Vercel entry does not
 *
 * Deno Deploy runs a long-lived process and expects it to listen, which is the
 * ordinary `aai start` shape rather than the serverless one — so this is the
 * only target whose entry calls `listen()`. There is no `(req, res)` adapter
 * and no upgrade translation: `node:http` and the `ws` server path both work
 * on Deno, so the session reaches the same `AgentServer` that `aai dev` and
 * `aai start` run. Verified against a live deployment with real speech: 74
 * audio frames back, transcript and reply intact.
 *
 * `0.0.0.0`, not the loopback default: the platform reaches this from outside
 * the process, so binding loopback answers nothing.
 *
 * `import.meta.dirname` rather than `process.cwd()` — the artifacts are copied
 * in BESIDE this file, and the working directory belongs to the platform.
 *
 * `globalThis.Deno?.env` rather than `Deno.env`: this file is bundled by a
 * Node-side build and is read by Node tooling (its own spec included), where a
 * bare `Deno` is a `ReferenceError` at parse-adjacent evaluation time.
 */
export const DENO_ENTRY_SOURCE = `// Generated by \`aai build --target deno\` — do not edit, and do not commit.
// Deno Deploy runs this as a long-lived process and expects it to listen.
// See @alexkroman1/aai-cli/start.
import { createProjectServer } from "@alexkroman1/aai-cli/start";

const server = await createProjectServer({ cwd: import.meta.dirname });

await server.listen(Number(globalThis.Deno?.env.get("PORT") ?? 8000), "0.0.0.0");
`;
