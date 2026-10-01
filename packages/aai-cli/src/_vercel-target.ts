// Copyright 2026 the AAI authors. MIT license.
/**
 * The **Vercel** target — a PREBUILT deployment under `.vercel/output/`.
 *
 * Its own module for the reason Nitro keeps a directory per preset: a host's
 * expected shape is one self-contained body of knowledge (a routing table, a
 * function config, an entry in whatever shape its launcher invokes), and the
 * only thing the others need from it is where its output lands. `TARGET_OUTPUTS`
 * in `_build-target.ts` is that seam; `_vercel-output.ts` does the assembling.
 *
 * Vercel is also the one target here that is SERVERLESS. Everything in
 * `_deno-target.ts` and `_modal-target.ts` is a long-lived process that binds a
 * port and drains on a signal; nothing in this file binds anything, and the
 * differences below all follow from that.
 */

import path from "node:path";

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

/**
 * What an unparsable `process.versions.node` is treated as. A build that cannot
 * say which Node it is still has to name SOME runtime, and the current LTS is
 * the least surprising one to land on.
 */
const UNKNOWN_NODE_MAJOR = 22;

/**
 * `nodejs<major>.x` for the Node running this build, resolved to what Vercel
 * offers — the SMALLEST offered major that is at least this one, and the
 * newest offered when the build is newer than all of them.
 *
 * **Rounding UP is the load-bearing half**, and it used to round down. The
 * bundle in the function was produced by, and resolved its dependencies for,
 * the Node running the build; placing it on an OLDER major is how a
 * `node:`-builtin API that shipped in 23 becomes a runtime `TypeError` in a
 * deployed function that built clean. A build on Node 23 named `nodejs22.x`
 * for exactly that reason. Rounding up cannot produce that failure — Node
 * majors do not remove APIs on the schedule they add them — so the direction
 * that can only be wrong cosmetically is the one to take. It is also what
 * Nitro's `resolveVercelRuntime` does (`find(v => v >= systemNodeVersion)`)
 * over this same list.
 *
 * Above the list there is nothing to round up TO, so a build on Node 26 is
 * clamped to the newest Vercel offers rather than naming a runtime the
 * deployment would be rejected for.
 */
export function vercelNodeRuntime(version: string = process.versions.node): string {
  const parsed = Number.parseInt(version.split(".")[0] ?? "", 10);
  const major = Number.isNaN(parsed) ? UNKNOWN_NODE_MAJOR : parsed;
  const supported =
    SUPPORTED_NODE_MAJORS.find((v) => v >= major) ?? Math.max(...SUPPORTED_NODE_MAJORS);
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
 * The client's CONTENT-ADDRESSED directory — Vite's default `build.assetsDir`,
 * which neither `client-bundler.ts` nor `aai-ui`'s own default-client build
 * overrides. Everything under it carries a content hash in its filename.
 *
 * Named here because two routes below depend on that property and on nothing
 * else: a file whose name changes with its bytes can be cached forever, and a
 * MISS under such a name can never be answered by anything.
 */
const CLIENT_ASSETS_DIR = "assets";

/** One year — the conventional ceiling, and what a content-hashed URL earns. */
const IMMUTABLE_MAX_AGE = 31_536_000;

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
 *
 * ## The two rules AROUND `filesystem`, and why a filesystem hit is not enough
 *
 * Both come from Nitro's `getPublicAssetRoutes`, which brackets its own
 * `handle: filesystem` the same way, and both are about
 * {@link CLIENT_ASSETS_DIR} rather than about static files in general.
 *
 * **Before** it, a `cache-control` rule with `continue: true`. Serving a
 * content-hashed bundle from the CDN with no explicit freshness leaves it on
 * Vercel's default, so every client re-validates every asset on every load —
 * a round trip per file for bytes that CANNOT change, since a change produces
 * a different filename. `continue: true` is what keeps this a header rule and
 * not a terminal one: the request goes on to `filesystem` and is served there.
 *
 * **After** it, a terminal `404` for the same prefix. A miss under a hashed
 * name is a stale `index.html` asking for a bundle this deployment does not
 * have, and there is no version of that request the agent can answer — so
 * falling through to the function buys an invocation to produce the 404 the
 * CDN could have. Nitro's reason is the sharper one and applies here too: the
 * immutable header above is already attached, and letting a DYNAMIC response
 * inherit it would cache a 404 for a year. `no-store` is what takes it back.
 *
 * Everything outside {@link CLIENT_ASSETS_DIR} still falls through, which is
 * what keeps `/`, `/favicon.ico` and every agent route working.
 */
export const VERCEL_BUILD_CONFIG_SOURCE = `${JSON.stringify(
  {
    version: 3,
    routes: [
      {
        src: `/${CLIENT_ASSETS_DIR}/(.*)`,
        headers: { "cache-control": `public, max-age=${IMMUTABLE_MAX_AGE}, immutable` },
        continue: true,
      },
      { handle: "filesystem" },
      {
        src: `/${CLIENT_ASSETS_DIR}/(.*)`,
        status: 404,
        headers: { "cache-control": "no-store" },
        continue: false,
      },
      { src: "/(.*)", dest: VERCEL_FUNCTION_ROUTE },
    ],
  },
  null,
  2,
)}\n`;
