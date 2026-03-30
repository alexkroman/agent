/**
 * Typecheck the harness runtime using @secure-exec/typescript.
 *
 * Replaces the former Rolldown isolate-guard plugin. Runs the TypeScript
 * compiler inside a secure-exec sandbox to validate _harness-runtime.ts.
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

if (!result.success) {
  console.error("[check-harness] Typecheck failed:");
  for (const d of result.diagnostics) {
    const loc = d.filePath ? `${d.filePath}${d.line != null ? `:${d.line}` : ""}` : "";
    console.error(`  ${loc} - error TS${d.code}: ${d.message}`);
  }
  process.exit(1);
}

console.log("[check-harness] Typecheck passed");
