/**
 * Sandboxed TypeScript type checking via @secure-exec/typescript.
 *
 * Runs the TypeScript compiler inside a secure-exec sandbox to validate
 * agent code is type-correct in the target execution environment.
 */

import { createRequire } from "node:module";
import {
  NodeFileSystem,
  allowAllFs,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
} from "secure-exec";
import { createTypeScriptTools } from "@secure-exec/typescript";

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
  for (const d of result.diagnostics) {
    const loc = d.filePath ? `${d.filePath}${d.line != null ? `:${d.line}` : ""}` : "";
    console.error(`${loc} - error TS${d.code}: ${d.message}`);
  }
  process.exit(1);
}
