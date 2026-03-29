import { defineConfig, type Rolldown } from "tsdown";

/**
 * Node builtins available in secure-exec isolates.
 * Source: @secure-exec/core POLYFILL_CODE_MAP keys.
 */
const SECURE_EXEC_BUILTINS = new Set([
  "node:assert",
  "node:buffer",
  "node:child_process",
  "node:cluster",
  "node:console",
  "node:constants",
  "node:crypto",
  "node:dgram",
  "node:dns",
  "node:domain",
  "node:events",
  "node:fs",
  "node:http",
  "node:https",
  "node:http2",
  "node:module",
  "node:net",
  "node:os",
  "node:path",
  "node:punycode",
  "node:process",
  "node:querystring",
  "node:readline",
  "node:repl",
  "node:stream",
  "node:string_decoder",
  "node:sys",
  "node:timers",
  "node:timers/promises",
  "node:tls",
  "node:tty",
  "node:url",
  "node:util",
  "node:vm",
  "node:zlib",
]);

/** Fails the build if the harness bundle imports anything unavailable in secure-exec. */
function isolateGuardPlugin(): Rolldown.Plugin {
  return {
    name: "isolate-guard",
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        const illegal = [...chunk.imports, ...chunk.dynamicImports].filter(
          (id) => !(id.startsWith("node:") && SECURE_EXEC_BUILTINS.has(id)),
        );
        // Filter to only actual externals (not node: builtins)
        const bad = illegal.filter((id) => !SECURE_EXEC_BUILTINS.has(id));
        if (bad.length > 0) {
          throw new Error(
            "[isolate-guard] Harness bundle contains imports unavailable in secure-exec.\n" +
              `Found: ${bad.join(", ")}`,
          );
        }
      }
    },
  };
}

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: "esm",
    platform: "node",
    target: "node22",
    outDir: "dist",
    noExternal: [/@alexkroman1/],
  },
  {
    entry: ["src/_harness-runtime.ts"],
    format: "esm",
    platform: "node",
    target: "node22",
    outDir: "dist",
    noExternal: [/@alexkroman1\/aai\/hooks/, /@alexkroman1\/aai\/utils/, /^hookable$/],
    plugins: [isolateGuardPlugin()],
  },
]);
