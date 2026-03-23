/**
 * Generates the "exports" field in package.json from a compact manifest.
 *
 * Usage: node scripts/gen-exports.mjs        — prints diff
 *        node scripts/gen-exports.mjs --write — updates package.json in place
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname, "../package.json");

// ── Manifest: [subpath, sourceFile] ──────────────────────────────
// For a standard sdk/ export, just use the subpath name — the source
// file is derived automatically (kebab → snake, sdk/{name}.ts).
// For non-standard mappings, provide the source file explicitly.
const manifest = [
  [".", "./sdk/mod.ts"],
  ["./types", "./sdk/types.ts"],
  ["./kv", "./sdk/kv.ts"],
  ["./vector", "./sdk/vector.ts"],
  ["./testing", "./sdk/_mock_ws.ts"],
  ["./server", "./sdk/server.ts"],
  ["./runtime", "./sdk/runtime.ts"],
  ["./ui", "./ui/mod.ts"],
  ["./ui/styles.css"],
  ["./ui/session", "./ui/session_mod.ts"],
  ["./ui/components", "./ui/components_mod.ts"],
  ["./internal-types", "./sdk/_internal_types.ts"],
  ["./protocol", "./sdk/protocol.ts"],
  ["./worker-entry", "./sdk/worker_entry.ts"],
  ["./builtin-tools", "./sdk/builtin_tools.ts"],
  ["./s2s", "./sdk/s2s.ts"],
  ["./session", "./sdk/session.ts"],
  ["./ws-handler", "./sdk/ws_handler.ts"],
  ["./direct-executor", "./sdk/direct_executor.ts"],
  ["./capnweb", "./sdk/capnweb.ts"],
  ["./host", "./sdk/host.ts"],
  ["./winterc-server", "./sdk/winterc_server.ts"],
  ["./worker-shim", "./sdk/worker_shim.ts"],
];

function buildExports(entries) {
  const exports = {};
  for (const [subpath, source] of entries) {
    // Plain file re-export (e.g. CSS)
    if (!source) {
      exports[subpath] = subpath.replace("./", "./");
      continue;
    }
    // Derive dist path: ./sdk/foo.ts → ./dist/sdk/foo
    const base = source.replace(/\.tsx?$/, "");
    const distBase = base.replace("./", "./dist/");
    exports[subpath] = {
      source,
      types: `${distBase}.d.ts`,
      default: `${distBase}.js`,
    };
  }
  return exports;
}

const newExports = buildExports(manifest);

const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
const oldJSON = JSON.stringify(pkg.exports, null, 2);
const newJSON = JSON.stringify(newExports, null, 2);

if (oldJSON === newJSON) {
  console.log("exports map is up to date.");
  process.exit(0);
}

if (process.argv.includes("--write")) {
  pkg.exports = newExports;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log("Updated package.json exports.");
} else {
  console.log("exports map is out of date. Run with --write to update.\n");
  console.log("Expected:\n" + newJSON);
  process.exit(1);
}
