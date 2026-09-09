import { defineConfig } from "tsdown";

/**
 * `aai-server` is COMPILED IN, and the pattern has to match its subpaths.
 *
 * Every import of it is a subpath (`aai-server/stores`, `aai-server/platform`,
 * … — all seven capability entries), so a bare `/^aai-server$/` matches nothing
 * and the whole package stays external. It did, for a long time, and nothing
 * said so: the build succeeds, `dist/index.mjs` is merely 150 KB of import
 * statements instead of a bundle, and the entry runs.
 *
 * What it costs is paid at every container COLD START. aai-server's exports map
 * resolves to `.ts` SOURCE — there is no build — so an externalized entry makes
 * every boot resolve, read, type-strip and compile ~72 TypeScript modules
 * before serving a request, and leaves the compile cache the deploy image bakes
 * (`scripts/modal_image.py`) with 72 files to key on instead of one bundle.
 *
 * `@alexkroman1/aai` stays external on purpose: it ships compiled `dist` JS, so
 * it costs no type-stripping, and bundling a published package's provider
 * graph in buys nothing here. (The pattern this replaced also listed `/^aai$/`,
 * the pre-scope name — dead since the rename, and matching nothing either.)
 */
const BUNDLED_WORKSPACE_DEPS = [/^aai-server(\/.*)?$/];

/**
 * Kept WHOLE, because a bundled copy cannot find its own files.
 *
 * Compiling `aai-server` in swallows its dependencies too — 52 of them, none
 * named anywhere until `check:bundled-deps` started baselining the set. Inlining
 * is free for pure JS and it is fatal for a package that resolves anything by
 * its own module location, silently: the build succeeds, tsc is happy, and the
 * module still evaluates. `@alexkroman1/aai-ui` was one, and every deployed
 * agent page answered 500 for a default client UI that was installed.
 *
 * `modal` is the ROOT of that hazard rather than the five packages under it
 * (`protobufjs` and `@grpc/proto-loader` read descriptors off disk; `cbor-x`
 * loads `cbor-extract`, which finds a native addon through
 * `node-gyp-build-optional-packages` and `detect-libc`). Externalizing the root
 * keeps them resolving through modal's own `node_modules`, so this is one
 * declaration instead of five — and it takes 26 of the 52 out with it.
 *
 * `microsandbox` is the same shape found by audit rather than by outage:
 * `dist/internal/resolve-binary.js` locates a native addon from
 * `import.meta.url`, and shipped code reaches it through
 * `await import("microsandbox")`, which rolldown inlines. Unlike `modal` it is
 * deliberately NOT declared in this package: it is a local-dev sandbox backend
 * behind a `try`/`catch` and a devDependency of aai-server, so being
 * unresolvable in production is correct — bundling it is the only reason that
 * backend was ever reachable there, native-addon lookup and all.
 *
 * Anything added here must be DECLARED in this package's `dependencies` unless,
 * like microsandbox, production is meant not to load it: an external specifier
 * is resolved at runtime from `dist/`, where pnpm's strict layout offers only
 * what this manifest names. `bundled-deps.test.ts` holds both halves.
 */
const EXTERNAL_LOCATION_DEPENDENT = ["modal", "microsandbox"];

export default defineConfig([
  {
    // Service entry: AAI_SERVICE=studio (standalone) or combined (default).
    // One bundle per process — aai-server is compiled in, so module-level
    // state (slot caches, keyed locks, session notes) has exactly one copy in
    // the running process.
    entry: ["src/index.ts"],
    format: "esm",
    platform: "node",
    target: "node22",
    outDir: "dist",
    external: EXTERNAL_LOCATION_DEPENDENT,
    deps: { alwaysBundle: BUNDLED_WORKSPACE_DEPS },
  },
]);

/** @internal Exposed so `bundled-deps.test.ts` can hold the pattern to the real specifiers. */
export { BUNDLED_WORKSPACE_DEPS, EXTERNAL_LOCATION_DEPENDENT };
