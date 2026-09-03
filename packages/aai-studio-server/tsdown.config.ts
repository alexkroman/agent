import { defineConfig } from "tsdown";

/**
 * `aai-server` is COMPILED IN, and the pattern has to match its subpaths.
 *
 * Every import of it is a subpath (`aai-server/orchestrator`,
 * `aai-server/platform-barrel`, … — all 31 exports), so a bare `/^aai-server$/`
 * matches nothing and the whole package stays external. It did, for a long
 * time, and nothing said so: the build succeeds, `dist/index.mjs` is merely
 * 150 KB of import statements instead of a bundle, and the entry runs.
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
    deps: { alwaysBundle: BUNDLED_WORKSPACE_DEPS },
  },
]);

/** @internal Exposed so `bundled-deps.test.ts` can hold the pattern to the real specifiers. */
export { BUNDLED_WORKSPACE_DEPS };
