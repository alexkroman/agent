/**
 * Typecheck the harness runtime using @secure-exec/typescript.
 *
 * Replaces the former Rolldown isolate-guard plugin. Runs the TypeScript
 * compiler inside a secure-exec sandbox to validate harness-runtime.ts.
 */

import { createRequire } from "node:module";
import { createTypeScriptTools } from "@secure-exec/typescript";
import {
  allowAllFs,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
  NodeFileSystem,
} from "secure-exec";

const require = createRequire(import.meta.url);
const compilerSpecifier = require.resolve("typescript/lib/typescript.js");

const ts = createTypeScriptTools({
  systemDriver: createNodeDriver({
    filesystem: new NodeFileSystem(),
    permissions: { ...allowAllFs },
  }),
  runtimeDriverFactory: createNodeRuntimeDriverFactory(),
  compilerSpecifier,
});

const result = await ts.typecheckProject({
  cwd: process.cwd(),
  configFilePath: `${process.cwd()}/tsconfig.json`,
});

// In secure-exec 0.2.x, the module access overlay is stricter about symlink
// validation. In a pnpm monorepo, some transitive deps of workspace packages
// resolve to canonical paths outside the allowed roots, causing TS2307 errors
// in both node_modules and workspace source files (e.g. aai/host/s2s.ts
// importing nanoevents). Only report errors from aai-server's own source
// files — workspace dependencies have their own typecheck.
const serverDir = `${process.cwd()}/`;
const ownDiagnostics = result.diagnostics.filter(
  (d) => d.filePath && d.filePath.startsWith(serverDir) && !d.filePath.includes("/node_modules/"),
);

if (ownDiagnostics.length > 0) {
  console.error("[check-harness] Typecheck failed:");
  for (const d of ownDiagnostics) {
    const loc = d.filePath ? `${d.filePath}${d.line != null ? `:${d.line}` : ""}` : "";
    console.error(`  ${loc} - error TS${d.code}: ${d.message}`);
  }
  process.exit(1);
}

console.log("[check-harness] Typecheck passed");
