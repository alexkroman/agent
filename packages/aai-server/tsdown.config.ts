import { defineConfig, type Rolldown } from "tsdown";

/**
 * Fails the build if the harness bundle contains external imports that aren't
 * node: built-ins or explicitly allowed lazy-loaded externals.
 *
 * The secure-exec isolate has no access to node_modules, so any non-built-in
 * external would cause a silent boot failure (15s timeout).
 *
 * Allowed dynamic externals are packages that are lazily imported and fail
 * gracefully at runtime (e.g. secure-exec for run_code, html-to-text for
 * visit_webpage). They never execute at boot time.
 */
function isolateGuardPlugin(): Rolldown.Plugin {
  // Dynamic imports that are OK to remain external — they're lazy-loaded
  // and fail gracefully at runtime (never evaluated at boot time).
  const ALLOWED_DYNAMIC_EXTERNALS = new Set(["secure-exec", "html-to-text"]);

  return {
    name: "isolate-guard",
    generateBundle(_options, bundle) {
      const chunkNames = new Set(Object.keys(bundle));
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        const isAllowed = (id: string) =>
          id.startsWith("node:") || chunkNames.has(id) || ALLOWED_DYNAMIC_EXTERNALS.has(id);
        const illegal = [...chunk.imports, ...chunk.dynamicImports].filter((id) => !isAllowed(id));
        if (illegal.length > 0) {
          throw new Error(
            "[isolate-guard] _harness-runtime.ts must not import external packages " +
              "(the isolate has no node_modules).\n" +
              `Found: ${illegal.join(", ")}\n` +
              "Use `import type` for type-only imports, or add the package to " +
              "noExternal if it has zero runtime dependencies.",
          );
        }
      }
    },
  };
}

export default defineConfig([
  // Main server bundle — bundle workspace packages, externalize npm deps
  {
    entry: ["src/index.ts"],
    format: "esm",
    platform: "node",
    target: "node22",
    outDir: "dist",
    noExternal: [/@alexkroman1/],
  },
  // Harness runtime — loaded into secure-exec isolates.
  // Runs createRuntime() + WebSocket server (same code path as self-hosted).
  // IMPORTANT: All runtime dependencies must be bundled — the isolate has
  // no access to node_modules. Only node: builtins are available externally.
  {
    entry: ["src/_harness-runtime.ts"],
    format: "esm",
    platform: "node",
    target: "node22",
    outDir: "dist",
    noExternal: [
      /@alexkroman1\/aai\/(internal|hooks|utils|kv|types)/,
      /^hookable$/,
      /^p-timeout$/,
      /^zod$/,
      /^nanoevents$/,
      /^@opentelemetry\/api$/,
      /^crossws/,
      /^unstorage$/,
      /^defu$/,
      /^json-schema$/,
    ],
    plugins: [isolateGuardPlugin()],
  },
]);
