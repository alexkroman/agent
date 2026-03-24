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
const sdkPkgPath = resolve(__dirname, "../sdk/package.json");

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

// Build SDK-only exports: entries sourced from sdk/, with paths relative to sdk/
function buildSdkExports(entries) {
  const exports = {};
  for (const [subpath, source] of entries) {
    if (!source || !source.startsWith("./sdk/")) continue;
    const relSource = source.replace("./sdk/", "./");
    const base = relSource.replace(/\.tsx?$/, "");
    exports[subpath] = {
      source: relSource,
      types: `./dist${base.slice(1)}.d.ts`,
      default: `./dist${base.slice(1)}.js`,
    };
  }
  return exports;
}

const newSdkExports = buildSdkExports(manifest);

const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
const sdkPkg = JSON.parse(readFileSync(sdkPkgPath, "utf-8"));

const oldJSON = JSON.stringify(pkg.exports, null, 2);
const newJSON = JSON.stringify(newExports, null, 2);
const oldSdkJSON = JSON.stringify(sdkPkg.exports, null, 2);
const newSdkJSON = JSON.stringify(newSdkExports, null, 2);

const rootOk = oldJSON === newJSON;
const sdkOk = oldSdkJSON === newSdkJSON;

if (rootOk && sdkOk) {
  console.log("exports maps are up to date.");
  process.exit(0);
}

if (process.argv.includes("--write")) {
  if (!rootOk) {
    pkg.exports = newExports;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    console.log("Updated package.json exports.");
  }
  if (!sdkOk) {
    sdkPkg.exports = newSdkExports;
    writeFileSync(sdkPkgPath, JSON.stringify(sdkPkg, null, 2) + "\n");
    console.log("Updated sdk/package.json exports.");
  }
} else {
  if (!rootOk) {
    console.log("package.json exports map is out of date.\n");
    console.log("Expected:\n" + newJSON);
  }
  if (!sdkOk) {
    console.log("sdk/package.json exports map is out of date.\n");
    console.log("Expected:\n" + newSdkJSON);
  }
  console.log("Run with --write to update.");
  process.exit(1);
}
