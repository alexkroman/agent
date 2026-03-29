import { readFileSync } from "node:fs";
import { defineConfig, type Rolldown } from "tsdown";

/**
 * Fails the build if the harness bundle contains external imports that aren't
 * node: built-ins. The secure-exec isolate has no access to node_modules, so
 * any non-built-in external would cause a silent boot failure (15s timeout).
 */
function isolateGuardPlugin(): Rolldown.Plugin {
  return {
    name: "isolate-guard",
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        const illegal = [...chunk.imports, ...chunk.dynamicImports].filter(
          (id) => !id.startsWith("node:"),
        );
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

// ── Constant sync guard ─────────────────────────────────────────────────
// _harness-runtime.ts duplicates constants from constants.ts because the
// isolate cannot import workspace packages at runtime. This plugin fails
// the build if the values drift.

/** Constants that must match: [name in constants.ts, name in _harness-runtime.ts] */
const SYNCED_CONSTANTS: [host: string, isolate: string][] = [
  ["HARNESS_TOOL_TIMEOUT_MS", "TOOL_TIMEOUT_MS"],
  ["HARNESS_MAX_BODY_SIZE", "MAX_BODY_SIZE"],
];

/** Evaluate a simple numeric expression (literals, underscores, multiplication). */
function evalNumericExpr(expr: string): number {
  const cleaned = expr.trim().replace(/_/g, "");
  if (cleaned.includes("*")) {
    return cleaned.split("*").reduce((acc, part) => acc * Number(part.trim()), 1);
  }
  return Number(cleaned);
}

function extractConst(source: string, name: string): number {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*([^;]+)`));
  if (!match) throw new Error(`[constant-sync] Could not find "const ${name}" in source`);
  return evalNumericExpr(match[1]);
}

function constantSyncPlugin(): Rolldown.Plugin {
  return {
    name: "constant-sync",
    buildStart() {
      const hostSrc = readFileSync("src/constants.ts", "utf-8");
      const isolateSrc = readFileSync("src/_harness-runtime.ts", "utf-8");

      for (const [hostName, isolateName] of SYNCED_CONSTANTS) {
        const hostVal = extractConst(hostSrc, hostName);
        const isolateVal = extractConst(isolateSrc, isolateName);
        if (hostVal !== isolateVal) {
          throw new Error(
            `[constant-sync] ${isolateName} in _harness-runtime.ts (${isolateVal}) ` +
              `does not match ${hostName} in constants.ts (${hostVal}). ` +
              "Update the harness constant to match.",
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
  // Uses node:http directly (not Hono) because @hono/node-server redefines
  // globalThis.Request which conflicts with secure-exec's frozen built-ins.
  // IMPORTANT: Only use type-only imports from workspace packages here —
  // the isolate has no access to node_modules.
  // EXCEPTION: hooks (+ hookable) and utils are explicitly bundled via
  // noExternal because they have zero Node-specific dependencies.
  {
    entry: ["src/_harness-runtime.ts"],
    format: "esm",
    platform: "node",
    target: "node22",
    outDir: "dist",
    noExternal: [/@alexkroman1\/aai\/hooks/, /@alexkroman1\/aai\/utils/, /^hookable$/],
    plugins: [constantSyncPlugin(), isolateGuardPlugin()],
  },
]);
