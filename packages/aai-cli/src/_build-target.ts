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
export const BUILD_TARGETS = ["node", "vercel"] as const;

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
 */
export const TARGET_ENV_MARKERS: Readonly<Record<string, BuildTarget>> = {
  VERCEL: "vercel",
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
 * Named `index.func` because the Build Output API derives a function's ROUTE
 * from its path — `functions/index.func` is served at `/index`, which is what
 * {@link VERCEL_BUILD_CONFIG_SOURCE}'s catch-all names as its `dest`.
 */
export const VERCEL_FUNCTION_DIR = path.join(VERCEL_OUTPUT_DIR, "functions", "index.func");

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
    routes: [{ handle: "filesystem" }, { src: "/(.*)", dest: "/index" }],
  },
  null,
  2,
)}\n`;
