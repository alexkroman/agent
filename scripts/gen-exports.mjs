/**
 * Generates the "exports" field in package.json files from a compact manifest.
 *
 * Usage: node scripts/gen-exports.mjs              — check (dev exports, .ts source)
 *        node scripts/gen-exports.mjs --write       — update package.json (dev)
 *        node scripts/gen-exports.mjs --write --dist — update for publishing (.js dist)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sdkPkgPath = resolve(__dirname, "../packages/aai/package.json");
const uiPkgPath = resolve(__dirname, "../packages/aai-ui/package.json");

const distMode = process.argv.includes("--dist");

// ── SDK manifest: [subpath, sourceFile] ──────────────────────────────
const sdkManifest = [
  [".", "./mod.ts"],
  ["./types", "./types.ts"],
  ["./kv", "./kv.ts"],
  ["./vector", "./vector.ts"],
  ["./testing", "./_mock_ws.ts"],
  ["./server", "./server.ts"],
  ["./runtime", "./runtime.ts"],
  ["./internal-types", "./_internal_types.ts"],
  ["./protocol", "./protocol.ts"],
  ["./worker-entry", "./worker_entry.ts"],
  ["./builtin-tools", "./builtin_tools.ts"],
  ["./s2s", "./s2s.ts"],
  ["./session", "./session.ts"],
  ["./ws-handler", "./ws_handler.ts"],
  ["./direct-executor", "./direct_executor.ts"],
  ["./capnweb", "./capnweb.ts"],
  ["./host", "./host.ts"],
  ["./winterc-server", "./winterc_server.ts"],
  ["./worker-shim", "./worker_shim.ts"],
  ["./utils", "./_utils.ts"],
];

// ── UI manifest: [subpath, sourceFile] ──────────────────────────────
const uiManifest = [
  [".", "./mod.ts"],
  ["./styles.css"],
  ["./session", "./session_mod.ts"],
  ["./components", "./components_mod.ts"],
];

function buildExports(entries) {
  const exports = {};
  for (const [subpath, source] of entries) {
    if (!source) {
      exports[subpath] = subpath;
      continue;
    }
    if (distMode) {
      const base = source.replace(/\.tsx?$/, "");
      exports[subpath] = {
        source,
        types: `./dist${base.slice(1)}.d.ts`,
        default: `./dist${base.slice(1)}.js`,
      };
    } else {
      // Dev mode: point directly to .ts source for workspace resolution
      exports[subpath] = source;
    }
  }
  return exports;
}

function checkPackage(label, pkgPath, manifest) {
  const newExports = buildExports(manifest);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const oldJSON = JSON.stringify(pkg.exports, null, 2);
  const newJSON = JSON.stringify(newExports, null, 2);
  return { pkg, newExports, oldJSON, newJSON, ok: oldJSON === newJSON, label, pkgPath };
}

const checks = [
  checkPackage("packages/aai", sdkPkgPath, sdkManifest),
  checkPackage("packages/aai-ui", uiPkgPath, uiManifest),
];

const allOk = checks.every((c) => c.ok);

if (allOk) {
  console.log("exports maps are up to date.");
  process.exit(0);
}

if (process.argv.includes("--write")) {
  for (const c of checks) {
    if (!c.ok) {
      c.pkg.exports = c.newExports;
      writeFileSync(c.pkgPath, JSON.stringify(c.pkg, null, 2) + "\n");
      console.log(`Updated ${c.label}/package.json exports.`);
    }
  }
} else {
  for (const c of checks) {
    if (!c.ok) {
      console.log(`${c.label}/package.json exports map is out of date.\n`);
      console.log("Expected:\n" + c.newJSON);
    }
  }
  console.log("Run with --write to update.");
  process.exit(1);
}
